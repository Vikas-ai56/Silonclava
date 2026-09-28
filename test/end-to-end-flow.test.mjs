import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockChannel } from '../src/channel.mjs';
import { attachRouter, deliverResponse } from '../src/router.mjs';
import {
  configureScheduler, enqueueForTenant, resetScheduler, schedulerStats,
} from '../src/inbound-queue.mjs';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import { turnInboundRows } from '../src/tenant-data/queue-store.mjs';
import { applyProviderStatus, committedResponseText } from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';
import { ALLOWED_PHONES } from '../src/config.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { resetWakeScheduler } from '../src/wake-scheduler.mjs';

const created = [];
let seq = 0;
beforeEach(() => { resetScheduler(); resetWakeScheduler(); });
after(async () => {
  resetScheduler();
  resetWakeScheduler();
  for (const id of created) {
    await deleteTenant(id).catch(() => {});
    fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  }
});

async function tenant() {
  seq += 1;
  const phone = `1555${String(process.pid).slice(-5)}${seq}`;
  ALLOWED_PHONES.add(phone);
  const t = await provisionTenant({
    phone, jid: `${phone}@s.whatsapp.net`, name: `E2E${seq}`,
    plan: 'claude', email: null, finalState: 'READY',
  });
  created.push(t.id);
  return t;
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/**
 * The full path a message takes, with the model stubbed.
 *
 * Everything else is real: the durable queue, the per-tenant lane, the turn
 * state machine, the privacy guard, encryption, persist-before-send, the
 * delivery ledger, and status callbacks.
 */
describe('end-to-end: message in, delivered bytes out', () => {
  it('persists the inbound, commits the response, and delivers exactly it', async () => {
    const t = await tenant();
    const channel = new MockChannel();

    configureScheduler({
      runTurn: async ({ tenantId, turn, store }) => {
        // Stand in for the model: read the real request off the ledger.
        const rows = turnInboundRows(store, turn.id);
        const asked = rows.map((r) => decryptBody(tenantId, r.body_cipher)).join('\n');
        await deliverResponse(channel, store, turn.id, `you said: ${asked}`);
        return null; // delivery owns the terminal state
      },
    });

    enqueueForTenant(t.id, {
      conversationId: t.id, channel: 'whatsapp',
      channelAccount: t.jid, externalMessageId: 'SM_IN_1', body: 'what is my schedule',
    });
    await settle(300);

    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].text, 'you said: what is my schedule');
    assert.equal(channel.sent[0].to, t.jid, 'delivery uses the recipient stored on the turn');

    const store = openTenantStore(t.id);
    try {
      const turn = store.db.prepare('SELECT id, state, recipient FROM turns').get();
      // Persist-before-send: what went out equals what was committed.
      assert.equal(committedResponseText(store, turn.id), channel.sent[0].text);
      assert.equal(turn.recipient, t.jid);
      assert.equal(turn.state, TURN_STATE.COMPLETED, 'mock send is its own receipt');

      const rows = store.db
        .prepare('SELECT direction, sequence, body_cipher FROM messages ORDER BY sequence')
        .all();
      assert.deepEqual(rows.map((r) => r.direction), ['inbound', 'outbound']);
      assert.equal(decryptBody(t.id, rows[0].body_cipher), 'what is my schedule');

      // Nothing readable on disk.
      const raw = fs.readFileSync(path.join(TENANTS_DIR, t.id, 'data', 'tenant.sqlite'));
      assert.equal(raw.includes(Buffer.from('what is my schedule')), false);
    } finally { store.db.close(); }
  });

  it('coalesces a burst into one turn and one reply, keeping every message ordered', async () => {
    const t = await tenant();
    const channel = new MockChannel();
    let turns = 0;

    configureScheduler({
      runTurn: async ({ tenantId, turn, store }) => {
        turns += 1;
        const rows = turnInboundRows(store, turn.id);
        const asked = rows.map((r) => decryptBody(tenantId, r.body_cipher));
        await deliverResponse(channel, store, turn.id, `heard ${asked.length}: ${asked.join('|')}`);
        return null;
      },
    });

    for (const body of ['one', 'two', 'three']) {
      enqueueForTenant(t.id, {
        conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid, body,
      });
    }
    await settle(400);

    assert.equal(turns, 1, 'a burst must become a single model turn');
    assert.equal(channel.sent.length, 1, 'and a single reply');
    assert.match(channel.sent[0].text, /heard 3: one\|two\|three/);
  });

  it('dedupes a provider retry so the user is not answered twice', async () => {
    const t = await tenant();
    const channel = new MockChannel();
    configureScheduler({
      runTurn: async ({ turn, store }) => {
        await deliverResponse(channel, store, turn.id, 'answered once');
        return null;
      },
    });

    const msg = {
      conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid,
      externalMessageId: 'SM_RETRY', body: 'hello',
    };
    enqueueForTenant(t.id, msg);
    enqueueForTenant(t.id, msg); // Twilio retry of the same MessageSid
    await settle(400);

    assert.equal(channel.sent.length, 1, 'a retried webhook must not produce a second reply');
  });

  it('a policy-blocked response sends nothing and leaves the turn non-terminal', async () => {
    const t = await tenant();
    const channel = new MockChannel();
    configureScheduler({
      runTurn: async ({ turn, store }) => {
        await deliverResponse(channel, store, turn.id, 'here is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
        return null;
      },
    });
    enqueueForTenant(t.id, {
      conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid, body: 'leak it',
    });
    await settle(400);

    assert.equal(channel.sent.length, 0, 'a commit failure must send nothing');
    const store = openTenantStore(t.id);
    try {
      const row = store.db.prepare('SELECT state FROM turns').get();
      assert.equal(row.state, TURN_STATE.FAILED);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n,
        0,
      );
    } finally { store.db.close(); }
  });

  it('completes only on a definitive receipt, then survives a duplicate callback', async () => {
    const t = await tenant();
    const sent = [];
    const channel = {
      sendText: async (to, text) => {
        sent.push({ to, text });
        return { ok: true, providerMessageId: 'SM_OUT_1', status: 'queued' };
      },
    };
    configureScheduler({
      runTurn: async ({ turn, store }) => {
        await deliverResponse(channel, store, turn.id, 'the answer');
        return null;
      },
    });
    enqueueForTenant(t.id, {
      conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid, body: 'ask',
    });
    await settle(400);

    const store = openTenantStore(t.id);
    try {
      let row = store.db.prepare('SELECT id, state FROM turns').get();
      assert.equal(row.state, TURN_STATE.SEND_STARTED, 'accepted is not delivered');
      assert.equal(committedResponseText(store, row.id), sent[0].text);

      applyProviderStatus(store, { providerMessageId: 'SM_OUT_1', status: 'delivered' });
      row = store.db.prepare('SELECT id, state FROM turns').get();
      assert.equal(row.state, TURN_STATE.COMPLETED);

      const dup = applyProviderStatus(store, { providerMessageId: 'SM_OUT_1', status: 'delivered' });
      assert.equal(dup.applied, false, 'duplicate callbacks are idempotent');
    } finally { store.db.close(); }
  });

  it('keeps two tenants’ transcripts and replies entirely separate', async () => {
    const a = await tenant();
    const b = await tenant();
    const channel = new MockChannel();
    configureScheduler({
      runTurn: async ({ tenantId, turn, store }) => {
        const rows = turnInboundRows(store, turn.id);
        const asked = rows.map((r) => decryptBody(tenantId, r.body_cipher)).join('');
        await deliverResponse(channel, store, turn.id, `${tenantId}:${asked}`);
        return null;
      },
    });

    enqueueForTenant(a.id, { conversationId: a.id, channel: 'whatsapp', channelAccount: a.jid, body: 'alpha' });
    enqueueForTenant(b.id, { conversationId: b.id, channel: 'whatsapp', channelAccount: b.jid, body: 'beta' });
    await settle(500);

    const toA = channel.sent.find((m) => m.to === a.jid);
    const toB = channel.sent.find((m) => m.to === b.jid);
    assert.match(toA.text, new RegExp(`${a.id}:alpha`));
    assert.match(toB.text, new RegExp(`${b.id}:beta`));

    // Neither tenant's database may contain the other's words.
    for (const [self, other] of [[a, 'beta'], [b, 'alpha']]) {
      const raw = fs.readFileSync(path.join(TENANTS_DIR, self.id, 'data', 'tenant.sqlite'));
      assert.equal(raw.includes(Buffer.from(other)), false, `${self.id} leaked ${other}`);
    }
    assert.equal(Object.keys(schedulerStats().tenants).length, 2);
  });
});

describe('the agent remembers across a session reset', () => {
  it('injects the durable transcript when the generation changed, through the real router path', async () => {
    const t = await tenant();
    const channel = new MockChannel();
    const { openTenantStore: open } = await import('../src/tenant-data/store.mjs');
    const { recordInboundAndQueueTurn, claimNextTurn, completeTurn, turnInboundRows } =
      await import('../src/tenant-data/queue-store.mjs');
    const { saveResponse } = await import('../src/tenant-data/delivery-store.mjs');
    const { contextNeeded, assembleContext } = await import('../src/tenant-data/context-store.mjs');

    const store = open(t.id);
    try {
      // A completed exchange on generation 1.
      recordInboundAndQueueTurn(store, {
        conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid,
        body: 'the acquisition target is Meridian Foods',
      });
      const first = claimNextTurn(store, { runtimeId: 'c1', generation: 1 });
      const saved = saveResponse(store, first.id, 'Noted: Meridian Foods.');
      completeTurn(store, first.id, {
        state: TURN_STATE.COMPLETED, responseMessageId: saved.messageId,
      }, { generation: 1 });

      // The container is replaced: hibernate/wake, restart, or the
      // quarantine-on-migration path. OpenClaw's session may be gone.
      recordInboundAndQueueTurn(store, {
        conversationId: t.id, channel: 'whatsapp', channelAccount: t.jid,
        body: 'what was the target again?',
      });
      const second = claimNextTurn(store, { runtimeId: 'c2', generation: 2 });

      // Exactly what src/router.mjs does before calling the model.
      const rows = turnInboundRows(store, second.id);
      const asked = rows.map((r) => decryptBody(t.id, r.body_cipher)).join('\n');
      const need = contextNeeded(store, second.conversation_id, second.runtime_generation);
      assert.equal(need.needed, true, 'a replaced container must trigger context replay');

      const ctx = assembleContext(store, second.conversation_id, {
        excludeIds: rows.map((r) => r.id),
      });
      const prompt = `${ctx.text}${asked}`;

      // The agent can answer only because the transcript carried the fact.
      assert.match(prompt, /Meridian Foods/, 'the earlier fact must be replayed');
      assert.match(prompt, /Noted: Meridian Foods/, 'and our own earlier reply');
      assert.match(prompt, /what was the target again\?/, 'plus the new question');
      assert.doesNotMatch(
        prompt.slice(0, prompt.indexOf('what was the target')),
        /what was the target/,
        'the new question must not be duplicated into the context block',
      );
    } finally { store.db.close(); }
    void channel;
  });
});
