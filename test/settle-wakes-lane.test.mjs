import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn, claimNextTurn } from '../src/tenant-data/queue-store.mjs';
import { saveResponse, beginSend, recordSendResult, applyProviderStatus } from '../src/tenant-data/delivery-store.mjs';
import { handleStatusWebhook } from '../src/channels/index.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_settle_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

let n = 0;
const send = (store, body) => recordInboundAndQueueTurn(store, {
  conversationId: 'c1',
  channel: 'whatsapp',
  channelAccount: '+6591234567',
  externalMessageId: `SMin_${process.pid}_${n++}`,
  body,
  recipient: '+6591234567',
  at: new Date().toISOString(),
});

/**
 * The production stall, reproduced:
 *   turn A is sent, Twilio accepts but does not confirm -> A stays send_started
 *   turn B arrives and queues behind it
 *   executeTurn's finally runs, sees A still executing, gives up
 *   the provider callback later settles A -- and nothing re-checks the lane
 */
describe('a turn settled by a provider callback releases the lane', () => {
  it('applyProviderStatus reports that a turn settled', () => {
    const id = freshTenant('reports');
    const store = openTenantStore(id);
    try {
      const a = send(store, 'first');
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      const saved = saveResponse(store, a.turnId, 'the reply');
      const attempt = beginSend(store, a.turnId, saved.messageId);
      recordSendResult(store, a.turnId, saved.messageId, attempt, {
        ok: true, providerMessageId: 'SMsent', status: 'queued',
      });

      // Acceptance is not delivery: the turn is still executing.
      assert.equal(
        store.db.prepare('SELECT state FROM turns WHERE id = ?').get(a.turnId).state,
        TURN_STATE.SEND_STARTED,
      );

      const mid = applyProviderStatus(store, { providerMessageId: 'SMsent', status: 'sent' });
      assert.equal(mid.applied, true, 'sent advances the delivery');
      assert.equal(mid.settled, false, 'but a non-terminal status settles nothing');
      const stale = applyProviderStatus(store, { providerMessageId: 'SMsent', status: 'queued' });
      assert.equal(stale.applied, false, 'a backwards status is rejected');
      assert.equal(stale.settled, false, 'and reports settled explicitly, never undefined');

      const done = applyProviderStatus(store, { providerMessageId: 'SMsent', status: 'delivered' });
      assert.equal(done.settled, true, 'a terminal status settles the turn');
      assert.equal(
        store.db.prepare('SELECT state FROM turns WHERE id = ?').get(a.turnId).state,
        TURN_STATE.COMPLETED,
      );
    } finally { store.close?.(); }
  });

  it('the status webhook wakes the lane, and only when a turn settled', async () => {
    const id = freshTenant('webhook');
    const store = openTenantStore(id);
    try {
      const a = send(store, 'first');
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      const saved = saveResponse(store, a.turnId, 'the reply');
      const attempt = beginSend(store, a.turnId, saved.messageId);
      recordSendResult(store, a.turnId, saved.messageId, attempt, {
        ok: true, providerMessageId: 'SMsent', status: 'queued',
      });
      send(store, 'second'); // queues behind the un-settled turn

      const woken = [];
      const adapter = {
        verifyInbound: () => true,
        parseStatus: (raw) => raw,
        tenantFromStatusQuery: () => id,
      };
      const call = (status) => handleStatusWebhook({
        adapter,
        rawBody: { providerMessageId: 'SMsent', status },
        headers: {},
        url: 'https://example.test/webhooks/twilio/status',
        searchParams: new URLSearchParams(),
        openStore: () => openTenantStore(id),
        onTurnSettled: (t) => woken.push(t),
      });

      await call('sent');
      assert.deepEqual(woken, [], 'a non-terminal callback must not wake the lane');

      await call('delivered');
      assert.deepEqual(woken, [id], 'the settling callback is the only thing that knows to wake');
    } finally { store.close?.(); }
  });

  it('a wake failure never breaks the webhook', async () => {
    const id = freshTenant('throws');
    const store = openTenantStore(id);
    try {
      const a = send(store, 'first');
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      const saved = saveResponse(store, a.turnId, 'reply');
      const attempt = beginSend(store, a.turnId, saved.messageId);
      recordSendResult(store, a.turnId, saved.messageId, attempt, {
        ok: true, providerMessageId: 'SMboom', status: 'queued',
      });

      const res = await handleStatusWebhook({
        adapter: { verifyInbound: () => true, parseStatus: (r) => r, tenantFromStatusQuery: () => id },
        rawBody: { providerMessageId: 'SMboom', status: 'delivered' },
        headers: {},
        url: 'https://example.test/webhooks/twilio/status',
        searchParams: new URLSearchParams(),
        openStore: () => openTenantStore(id),
        onTurnSettled: () => { throw new Error('scheduler exploded'); },
      });
      assert.equal(res.ok, true, 'the provider must still get its 204');
      assert.equal(res.status, 204);
    } finally { store.close?.(); }
  });
});
