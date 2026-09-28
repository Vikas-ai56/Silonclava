import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn, claimNextTurn } from '../src/tenant-data/queue-store.mjs';
import {
  saveResponse, beginSend, recordSendResult, markDeliveryUnknown,
  applyProviderStatus, committedResponseText, saveCronResponse, turnsAwaitingSend,
} from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { deliverResponse } from '../src/router.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_pbs_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => { for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true }); });

const inbound = (body) => ({
  conversationId: 'c1', channel: 'whatsapp', channelAccount: '+6591234567', body,
});

function queuedTurn(store) {
  recordInboundAndQueueTurn(store, inbound('hello'));
  return claimNextTurn(store, { runtimeId: 'c1', generation: 1 });
}

describe('persist-before-send (§6, §7)', () => {
  it('delivers exactly the committed bytes', async () => {
    const id = freshTenant('exact');
    const store = openTenantStore(id);
    const sent = [];
    const channel = { sendText: async (to, text) => { sent.push({ to, text }); return { ok: true, providerMessageId: 'SM1', status: 'queued' }; } };
    try {
      const turn = queuedTurn(store);
      await deliverResponse(channel, store, turn.id, 'the approved answer');

      // The gate: delivered bytes equal the stored bytes after decryption.
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, committedResponseText(store, turn.id));
      assert.equal(sent[0].text, 'the approved answer');
      assert.equal(sent[0].to, '+6591234567', 'must use the recipient stored on the turn');

      // Twilio returned `queued`: accepted, not delivered. The turn must wait
      // for a definitive receipt rather than claim completion.
      const afterSend = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.equal(afterSend.state, TURN_STATE.SEND_STARTED);

      applyProviderStatus(store, { providerMessageId: 'SM1', status: 'delivered' });
      const afterCallback = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.equal(afterCallback.state, TURN_STATE.COMPLETED);
    } finally { store.db.close(); }
  });

  it('completes immediately for a channel whose send is its own receipt', async () => {
    const id = freshTenant('selfreceipt');
    const store = openTenantStore(id);
    // No asynchronous status callbacks exist for this channel, so a successful
    // send is definitive.
    const channel = { sendText: async () => ({ ok: true, providerMessageId: 'M1', status: 'delivered' }) };
    try {
      const turn = queuedTurn(store);
      await deliverResponse(channel, store, turn.id, 'answer');
      const row = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.state, TURN_STATE.COMPLETED);
    } finally { store.db.close(); }
  });

  it('sends nothing when the policy guard blocks the response', async () => {
    const id = freshTenant('blocked');
    const store = openTenantStore(id);
    let sends = 0;
    const channel = { sendText: async () => { sends += 1; return { ok: true }; } };
    try {
      const turn = queuedTurn(store);
      await assert.rejects(
        () => deliverResponse(channel, store, turn.id, 'your key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'),
        /persistence policy/i,
      );
      assert.equal(sends, 0, 'a commit failure must send nothing');
      const row = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.notEqual(row.state, TURN_STATE.COMPLETED);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n, 0);
    } finally { store.db.close(); }
  });

  it('marks delivery_unknown when the send throws, and does not resend blindly', async () => {
    const id = freshTenant('unknown');
    const store = openTenantStore(id);
    const channel = { sendText: async () => { throw Object.assign(new Error('socket hangup'), { code: 'ECONNRESET' }); } };
    try {
      const turn = queuedTurn(store);
      await assert.rejects(() => deliverResponse(channel, store, turn.id, 'answer'), /socket hangup/);
      const row = store.db.prepare('SELECT state, error_code FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.state, TURN_STATE.DELIVERY_UNKNOWN);
      // Not eligible for the committed-resend sweep: it may already be delivered.
      assert.deepEqual(turnsAwaitingSend(store).map((t) => t.id), []);
    } finally { store.db.close(); }
  });

  it('never re-invokes the model for a committed-but-unsent turn', () => {
    const id = freshTenant('awaiting');
    const store = openTenantStore(id);
    try {
      const turn = queuedTurn(store);
      saveResponse(store, turn.id, 'committed but not sent');
      const awaiting = turnsAwaitingSend(store);
      assert.deepEqual(awaiting.map((t) => t.id), [turn.id]);
      assert.equal(committedResponseText(store, turn.id), 'committed but not sent');
    } finally { store.db.close(); }
  });

  it('refuses to save a response for a turn from a replaced generation', () => {
    const id = freshTenant('stalegen');
    const store = openTenantStore(id);
    try {
      const turn = queuedTurn(store);
      assert.throws(
        () => saveResponse(store, turn.id, 'late answer', { generation: 99 }),
        /replaced container generation/,
      );
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n, 0);
    } finally { store.db.close(); }
  });
});

describe('delivery status callbacks (§6)', () => {
  function delivered(store) {
    const turn = queuedTurn(store);
    const saved = saveResponse(store, turn.id, 'answer');
    const attempt = beginSend(store, turn.id, saved.messageId);
    recordSendResult(store, turn.id, saved.messageId, attempt, {
      ok: true, providerMessageId: 'SM_ABC', status: 'sent',
    });
    return { turn, saved };
  }

  it('is idempotent for duplicate callbacks', () => {
    const id = freshTenant('dupe');
    const store = openTenantStore(id);
    try {
      delivered(store);
      const first = applyProviderStatus(store, { providerMessageId: 'SM_ABC', status: 'delivered' });
      const second = applyProviderStatus(store, { providerMessageId: 'SM_ABC', status: 'delivered' });
      assert.equal(first.applied, true);
      assert.equal(second.applied, false, 'a duplicate must not re-apply');
      // Both are still recorded as observations.
      const events = store.db.prepare("SELECT COUNT(*) n FROM message_events WHERE event_type='status:delivered'").get();
      assert.equal(events.n, 2);
    } finally { store.db.close(); }
  });

  it('cannot move a terminal delivery backwards', () => {
    const id = freshTenant('order');
    const store = openTenantStore(id);
    try {
      delivered(store);
      applyProviderStatus(store, { providerMessageId: 'SM_ABC', status: 'delivered' });
      const late = applyProviderStatus(store, { providerMessageId: 'SM_ABC', status: 'sent' });
      assert.equal(late.applied, false);
      assert.equal(late.reason, 'out_of_order');
      const row = store.db.prepare('SELECT status FROM delivery_attempts WHERE provider_message_id = ?').get('SM_ABC');
      assert.equal(row.status, 'delivered');
    } finally { store.db.close(); }
  });

  it('correlates by provider message id, never by phone number', () => {
    const id = freshTenant('correlate');
    const store = openTenantStore(id);
    try {
      delivered(store);
      const unknown = applyProviderStatus(store, { providerMessageId: 'SM_SOMEONE_ELSE', status: 'delivered' });
      assert.equal(unknown.applied, false);
      assert.equal(unknown.reason, 'unknown_provider_message');
    } finally { store.db.close(); }
  });

  it('records a provider failure as a failed turn', () => {
    const id = freshTenant('failstatus');
    const store = openTenantStore(id);
    try {
      const { turn } = delivered(store);
      applyProviderStatus(store, { providerMessageId: 'SM_ABC', status: 'failed', errorCode: '63016' });
      const row = store.db.prepare('SELECT state, error_code FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.state, TURN_STATE.FAILED);
      assert.equal(row.error_code, '63016');
    } finally { store.db.close(); }
  });
});

describe('cron delivery converges on the same path (§1.4b)', () => {
  it('lands as an outbound message and a turn at response_saved', () => {
    const id = freshTenant('cron');
    const store = openTenantStore(id);
    try {
      const saved = saveCronResponse(store, {
        conversationId: id, recipient: '+6591234567', text: 'your 9am digest', runId: 'run-1',
      });
      const turn = store.db.prepare('SELECT * FROM turns WHERE id = ?').get(saved.turnId);
      assert.equal(turn.state, TURN_STATE.RESPONSE_SAVED);
      assert.equal(turn.route, 'cron');
      assert.equal(turn.recipient, '+6591234567');

      const msg = store.db.prepare('SELECT direction, body_cipher FROM messages WHERE id = ?').get(saved.messageId);
      assert.equal(msg.direction, 'outbound');
      // Ledgered and encrypted like any other response.
      assert.equal(decryptBody(id, msg.body_cipher), 'your 9am digest');
      assert.equal(committedResponseText(store, saved.turnId), 'your 9am digest');
    } finally { store.db.close(); }
  });

  it('is idempotent on the cron run id, so a webhook retry cannot double-send', () => {
    const id = freshTenant('cronretry');
    const store = openTenantStore(id);
    try {
      const a = saveCronResponse(store, { conversationId: id, recipient: '+65', text: 'digest', runId: 'run-9' });
      const b = saveCronResponse(store, { conversationId: id, recipient: '+65', text: 'digest', runId: 'run-9' });
      assert.equal(a.duplicate, false);
      assert.equal(b.duplicate, true);
      assert.equal(b.turnId, a.turnId);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n, 1);
    } finally { store.db.close(); }
  });

  it('applies the same privacy guard as a user reply', () => {
    const id = freshTenant('cronpolicy');
    const store = openTenantStore(id);
    try {
      assert.throws(
        () => saveCronResponse(store, {
          conversationId: id, recipient: '+65', runId: 'run-x',
          text: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K',
        }),
        /persistence policy/i,
      );
    } finally { store.db.close(); }
  });
});
