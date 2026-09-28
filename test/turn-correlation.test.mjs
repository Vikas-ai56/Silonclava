import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn,
  claimNextTurn,
  completeTurn,
  StaleTurnResultError,
} from '../src/tenant-data/queue-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_corr_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function inbound(body, extra = {}) {
  return {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    body,
    ...extra,
  };
}

describe('immutable turn envelope (§5)', () => {
  it('freezes the recipient and route onto the turn at enqueue', () => {
    const id = freshTenant('envelope');
    const store = openTenantStore(id);
    try {
      const { turnId } = recordInboundAndQueueTurn(store, inbound('hello'));
      const turn = store.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
      assert.equal(turn.recipient, '+6591234567');
      assert.equal(turn.route, 'openclaw');
      assert.ok(turn.request_id.startsWith('req_'));
    } finally {
      store.db.close();
    }
  });

  it('stamps runtime id and generation at claim', () => {
    const id = freshTenant('stamp');
    const store = openTenantStore(id);
    try {
      recordInboundAndQueueTurn(store, inbound('hello'));
      const turn = claimNextTurn(store, { runtimeId: 'rocky-oc-abc', generation: 7 });
      assert.equal(turn.runtime_id, 'rocky-oc-abc');
      assert.equal(turn.runtime_generation, 7);
      const row = store.db.prepare('SELECT * FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.runtime_generation, 7, 'generation must be persisted, not just returned');
    } finally {
      store.db.close();
    }
  });

  it('rejects a reply from a replaced container generation', () => {
    const id = freshTenant('stalegen');
    const store = openTenantStore(id);
    try {
      recordInboundAndQueueTurn(store, inbound('hello'));
      const turn = claimNextTurn(store, { runtimeId: 'c1', generation: 3 });

      // The container was recreated mid-turn; this reply is from generation 3
      // arriving when the turn was stamped at 3 but the caller claims 2.
      assert.throws(
        () => completeTurn(store, turn.id, { state: TURN_STATE.COMPLETED }, { generation: 2 }),
        (err) => err instanceof StaleTurnResultError && /replaced container generation/.test(err.message),
      );

      // The turn must be untouched, so it can still be re-executed.
      const row = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.state, TURN_STATE.CLAIMED);
    } finally {
      store.db.close();
    }
  });

  it('rejects a result whose request id does not match the claimed turn', () => {
    const id = freshTenant('wrongreq');
    const store = openTenantStore(id);
    try {
      recordInboundAndQueueTurn(store, inbound('hello'));
      const turn = claimNextTurn(store, { runtimeId: 'c1', generation: 1 });
      assert.throws(
        () => completeTurn(store, turn.id, { state: TURN_STATE.COMPLETED }, { requestId: 'req_someone_else' }),
        /does not match the claimed request/,
      );
    } finally {
      store.db.close();
    }
  });

  it('refuses to move a turn that already reached a terminal state', () => {
    const id = freshTenant('terminal');
    const store = openTenantStore(id);
    try {
      recordInboundAndQueueTurn(store, inbound('hello'));
      const turn = claimNextTurn(store, { runtimeId: 'c1', generation: 1 });
      completeTurn(store, turn.id, { state: TURN_STATE.COMPLETED }, { generation: 1 });

      // A duplicate or out-of-order completion must not regress it.
      for (const state of [TURN_STATE.FAILED, TURN_STATE.COMPLETED, TURN_STATE.QUEUED]) {
        assert.throws(
          () => completeTurn(store, turn.id, { state }, { generation: 1 }),
          /already reached a terminal state/,
          `${state} should not overwrite a terminal turn`,
        );
      }
      const row = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id);
      assert.equal(row.state, TURN_STATE.COMPLETED);
    } finally {
      store.db.close();
    }
  });

  it('keeps the recipient of the turn, not of a later message', () => {
    const id = freshTenant('recipient');
    const store = openTenantStore(id);
    try {
      const first = recordInboundAndQueueTurn(store, inbound('one'));
      // A coalesced follow-up arriving from a different address must not
      // repoint delivery of the already-queued turn.
      recordInboundAndQueueTurn(store, inbound('two', { channelAccount: '+6599999999' }));
      const turn = store.db.prepare('SELECT recipient FROM turns WHERE id = ?').get(first.turnId);
      assert.equal(turn.recipient, '+6591234567');
    } finally {
      store.db.close();
    }
  });
});
