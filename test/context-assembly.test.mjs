import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn, claimNextTurn, completeTurn } from '../src/tenant-data/queue-store.mjs';
import { saveResponse } from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import {
  contextNeeded, assembleContext, recentMessages, saveCheckpoint,
  latestCheckpoint, latestSequence,
} from '../src/tenant-data/context-store.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
after(() => { for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true }); });
function fresh(tag) {
  const id = `br_ctx_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}

/** One complete exchange at a given container generation. */
function exchange(store, id, ask, reply, generation) {
  recordInboundAndQueueTurn(store, {
    conversationId: id, channel: 'whatsapp', channelAccount: '+65', body: ask,
  });
  const turn = claimNextTurn(store, { runtimeId: 'c', generation });
  const saved = saveResponse(store, turn.id, reply);
  completeTurn(store, turn.id, { state: TURN_STATE.COMPLETED, responseMessageId: saved.messageId },
    { generation });
  return turn;
}

describe('when context is needed', () => {
  it('is not needed on a first ever turn', () => {
    const id = fresh('first');
    const store = openTenantStore(id);
    try {
      assert.equal(contextNeeded(store, id, 1).needed, false);
    } finally { store.db.close(); }
  });

  it('is not needed while the container generation is unchanged', () => {
    const id = fresh('warm');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'hello', 'hi there', 1);
      const need = contextNeeded(store, id, 1);
      assert.equal(need.needed, false, 'a warm session already has the history');
      assert.match(need.reason, /same container generation/);
    } finally { store.db.close(); }
  });

  it('is needed once the container has been replaced', () => {
    const id = fresh('replaced');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'my budget is 5 crore', 'noted', 1);
      // Hibernate/wake, restart, or quarantine — the session may be gone.
      const need = contextNeeded(store, id, 2);
      assert.equal(need.needed, true);
      assert.match(need.reason, /generation changed 1 -> 2/);
    } finally { store.db.close(); }
  });

  it('decides from our own data, never OpenClaw session files', async () => {
    const src = await fs.promises.readFile('src/tenant-data/context-store.mjs', 'utf8');
    // P8: reading OpenClaw's session state to decide would make the agent's
    // memory depend on a format its owner may change.
    assert.doesNotMatch(src, /openclaw\.sqlite|agents\/main\/sessions|\.jsonl/);
  });
});

describe('assembling the context block', () => {
  it('replays the prior conversation in order, oldest first', () => {
    const id = fresh('order');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'the target is Acme', 'understood', 1);
      exchange(store, id, 'what did I say the target was', 'Acme', 1);

      const ctx = assembleContext(store, id);
      assert.ok(ctx);
      assert.match(ctx.text, /session was reset/);
      // Order matters: the model must read into the present.
      assert.ok(
        ctx.text.indexOf('the target is Acme') < ctx.text.indexOf('what did I say'),
        'oldest must come first',
      );
      assert.match(ctx.text, /User: the target is Acme/);
      assert.match(ctx.text, /Model response: understood/);
    } finally { store.db.close(); }
  });

  it('excludes the turn’s own messages, which the model already has', () => {
    const id = fresh('exclude');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'older question', 'older answer', 1);
      const { messageId } = recordInboundAndQueueTurn(store, {
        conversationId: id, channel: 'whatsapp', channelAccount: '+65', body: 'the new question',
      });
      const ctx = assembleContext(store, id, { excludeIds: [messageId] });
      assert.doesNotMatch(ctx.text, /the new question/, 'would duplicate the prompt');
      assert.match(ctx.text, /older question/);
    } finally { store.db.close(); }
  });

  it('stays inside the character budget by dropping the oldest', () => {
    const id = fresh('budget');
    const store = openTenantStore(id);
    try {
      for (let i = 0; i < 12; i += 1) {
        exchange(store, id, `question ${i} ${'x'.repeat(200)}`, `answer ${i}`, 1);
      }
      const ctx = assembleContext(store, id, { maxChars: 1200 });
      assert.ok(ctx.text.length < 2000, `context not bounded: ${ctx.text.length}`);
      // The most recent exchange must survive the trim.
      assert.match(ctx.text, /answer 11/);
      assert.doesNotMatch(ctx.text, /question 0 /, 'oldest should be dropped first');
    } finally { store.db.close(); }
  });

  it('prefers a checkpoint summary for the older part', () => {
    const id = fresh('checkpoint');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'early detail', 'ok', 1);
      saveCheckpoint(store, id, 'Earlier: the client is Acme, budget 5 crore.', latestSequence(store, id));
      exchange(store, id, 'recent question', 'recent answer', 1);

      const ctx = assembleContext(store, id);
      assert.equal(ctx.usedCheckpoint, true);
      assert.match(ctx.text, /Summary of earlier conversation/);
      assert.match(ctx.text, /budget 5 crore/);
      assert.match(ctx.text, /recent question/);
      assert.ok(
        ctx.text.indexOf('Summary of earlier') < ctx.text.indexOf('Recent messages'),
        'summary precedes verbatim messages',
      );
    } finally { store.db.close(); }
  });

  it('returns null when there is nothing to replay', () => {
    const id = fresh('empty');
    const store = openTenantStore(id);
    try {
      assert.equal(assembleContext(store, id), null);
    } finally { store.db.close(); }
  });

  it('survives a record it cannot decrypt rather than failing the turn', () => {
    const id = fresh('corrupt');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'readable message', 'fine', 1);
      // Simulate a body encrypted under a different key.
      store.db.prepare('UPDATE messages SET body_cipher = ? WHERE direction = ?')
        .run('{"_riftVault":1,"alg":"aes-256-gcm","kdf":"hkdf-sha256","keyId":"deadbeefdeadbeef","salt":"AA","iv":"AA","tag":"AA","ciphertext":"AA"}', 'outbound');
      const ctx = assembleContext(store, id);
      assert.ok(ctx, 'must still produce context');
      assert.match(ctx.text, /readable message/);
    } finally { store.db.close(); }
  });

  it('checkpoints round-trip encrypted', () => {
    const id = fresh('cpcrypt');
    const store = openTenantStore(id);
    try {
      exchange(store, id, 'x', 'y', 1);
      saveCheckpoint(store, id, 'Sensitive summary about Client A', latestSequence(store, id));
      assert.equal(latestCheckpoint(store, id).text, 'Sensitive summary about Client A');
      const raw = fs.readFileSync(path.join(TENANTS_DIR, id, 'data', 'tenant.sqlite'));
      assert.equal(raw.includes(Buffer.from('Sensitive summary')), false, 'checkpoint must be encrypted at rest');
    } finally { store.db.close(); }
  });
});
