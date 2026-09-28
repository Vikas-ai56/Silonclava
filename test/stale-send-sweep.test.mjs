import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn, claimNextTurn,
  staleSendStartedTurns, markOneSendStartedUnknown,
} from '../src/tenant-data/queue-store.mjs';
import { saveResponse, beginSend, recordSendResult } from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_stale_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

let n = 0;
function midSendTurn(store) {
  const r = recordInboundAndQueueTurn(store, {
    conversationId: 'c1', channel: 'whatsapp', channelAccount: '+6591234567',
    externalMessageId: `SM_${process.pid}_${n++}`, body: 'hi',
    recipient: '+6591234567', at: new Date().toISOString(),
  });
  claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
  const saved = saveResponse(store, r.turnId, 'the reply');
  const attempt = beginSend(store, r.turnId, saved.messageId);
  recordSendResult(store, r.turnId, saved.messageId, attempt, {
    ok: true, providerMessageId: 'SMsent', status: 'queued',
  });
  return r.turnId;
}

describe('a lost provider callback must not mute the agent forever', () => {
  it('finds a send that has sat too long without a terminal status', () => {
    const store = openTenantStore(freshTenant('find'));
    try {
      const turnId = midSendTurn(store);
      const now = Date.now();

      assert.deepEqual(staleSendStartedTurns(store, 10 * 60_000, { now }), [],
        'a send that just happened is not stale; Twilio usually settles in seconds');

      assert.deepEqual(
        staleSendStartedTurns(store, 10 * 60_000, { now: now + 11 * 60_000 }),
        [turnId],
        'this exact turn blocked a real tenant for 23 hours because nothing swept it',
      );
    } finally { store.close?.(); }
  });

  it('settles it as delivery_unknown, never as delivered', () => {
    const store = openTenantStore(freshTenant('settle'));
    try {
      const turnId = midSendTurn(store);
      assert.equal(markOneSendStartedUnknown(store, turnId, 'NO_PROVIDER_STATUS'), 1);
      const row = store.db.prepare('SELECT state, error_code FROM turns WHERE id = ?').get(turnId);
      assert.equal(row.state, TURN_STATE.DELIVERY_UNKNOWN,
        'the provider may already have delivered it, so it must never be resent blindly');
      assert.equal(row.error_code, 'NO_PROVIDER_STATUS');
    } finally { store.close?.(); }
  });

  it('does not touch a turn that has already settled', () => {
    const store = openTenantStore(freshTenant('settled'));
    try {
      const turnId = midSendTurn(store);
      markOneSendStartedUnknown(store, turnId, 'NO_PROVIDER_STATUS');
      assert.equal(markOneSendStartedUnknown(store, turnId, 'AGAIN'), 0,
        'the compare-and-swap means a second sweep is a no-op, not a state change');
    } finally { store.close?.(); }
  });
});
