import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn,
  claimNextTurn,
  completeTurn,
  recoverInterruptedTurns,
  queueDepth,
  hasWork,
  waitingDepth,
} from '../src/tenant-data/queue-store.mjs';
import { TURN_STATE, WAITING_STATES, PRE_COMMIT_STATES, TERMINAL_STATES } from '../src/tenant-data/migrations.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_wait_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

let n = 0;
function send(store, body = 'hello') {
  return recordInboundAndQueueTurn(store, {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    externalMessageId: `SMin_${process.pid}_${n++}`,
    body,
    recipient: '+6591234567',
    at: new Date().toISOString(),
  });
}
const park = (store, turnId, state) =>
  store.db.prepare('UPDATE turns SET state = ? WHERE id = ?').run(state, turnId);

describe('a parked turn does not block the lane', () => {
  for (const state of WAITING_STATES) {
    it(`a turn in ${state} still lets the next message be served`, () => {
      const id = freshTenant(state);
      const store = openTenantStore(id);
      try {
        const first = send(store);
        const claimed = claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
        assert.equal(claimed.id, first.turnId);
        park(store, first.turnId, state);

        // This is the deadlock: before the fix, every later turn was refused
        // for as long as the user took to answer.
        const second = send(store, 'are you there?');
        assert.notEqual(second.turnId, first.turnId, 'a new message must not join a parked turn');

        const next = claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
        assert.ok(next, `a ${state} turn must not block the lane`);
        assert.equal(next.id, second.turnId);
      } finally { store.close?.(); }
    });
  }

  it('an executing turn still blocks, as it always did', () => {
    const id = freshTenant('exec');
    const store = openTenantStore(id);
    try {
      send(store);
      assert.ok(claimNextTurn(store, { runtimeId: 'r1', generation: 1 }));
      send(store, 'second');
      assert.equal(
        claimNextTurn(store, { runtimeId: 'r1', generation: 1 }),
        null,
        'one executing turn per tenant is unchanged',
      );
    } finally { store.close?.(); }
  });
});

describe('parked work is not backlog, but is queryable', () => {
  it('queueDepth ignores parked turns so hasWork cannot stick true', () => {
    const id = freshTenant('depth');
    const store = openTenantStore(id);
    try {
      const t = send(store);
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      park(store, t.turnId, TURN_STATE.AWAITING_APPROVAL);
      assert.equal(queueDepth(store), 0);
      assert.equal(hasWork(store), false, 'a parked turn must not look like backlog');
    } finally { store.close?.(); }
  });

  it('waitingDepth answers "how much is stuck on me", by what ends the wait', () => {
    const id = freshTenant('wdepth');
    const store = openTenantStore(id);
    try {
      for (const state of WAITING_STATES) {
        const t = send(store);
        claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
        park(store, t.turnId, state);
      }
      const w = waitingDepth(store);
      assert.equal(w.total, WAITING_STATES.length);
      for (const state of WAITING_STATES) assert.equal(w.byState[state], 1);
    } finally { store.close?.(); }
  });
});

describe('recovery treats the three waits by what they were waiting on', () => {
  it('requeues the waits whose subject died with the process', () => {
    for (const state of [TURN_STATE.WAITING_SUBRUN, TURN_STATE.RETRY_WAIT]) {
      const id = freshTenant(`rec_${state}`);
      const store = openTenantStore(id);
      try {
        const t = send(store);
        claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
        park(store, t.turnId, state);
        assert.equal(recoverInterruptedTurns(store), 1, `${state} was waiting on something in memory`);
        assert.equal(
          store.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId).state,
          TURN_STATE.QUEUED,
        );
      } finally { store.close?.(); }
    }
  });

  it('leaves a turn awaiting a human alone — the crash did not destroy the human', () => {
    const id = freshTenant('rec_appr');
    const store = openTenantStore(id);
    try {
      const t = send(store);
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      park(store, t.turnId, TURN_STATE.AWAITING_APPROVAL);
      recoverInterruptedTurns(store);
      assert.equal(
        store.db.prepare('SELECT state FROM turns WHERE id = ?').get(t.turnId).state,
        TURN_STATE.AWAITING_APPROVAL,
        're-executing would ask the user twice',
      );
    } finally { store.close?.(); }
  });

  it('with write tools on, an interrupted park is marked rather than re-run', () => {
    const id = freshTenant('rec_write');
    const store = openTenantStore(id);
    try {
      const t = send(store);
      claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
      park(store, t.turnId, TURN_STATE.WAITING_SUBRUN);
      recoverInterruptedTurns(store, { writesEnabled: true });
      const row = store.db.prepare('SELECT state, error_code FROM turns WHERE id = ?').get(t.turnId);
      assert.equal(row.state, TURN_STATE.FAILED);
      assert.equal(row.error_code, 'UNCERTAIN_WRITE');
    } finally { store.close?.(); }
  });
});

describe('the state set stays classified', () => {
  it('every state is either pre-commit, post-commit or terminal', () => {
    const classified = new Set([...PRE_COMMIT_STATES, ...TERMINAL_STATES,
      TURN_STATE.RESPONSE_SAVED, TURN_STATE.SEND_STARTED]);
    const unclassified = Object.values(TURN_STATE).filter((s) => !classified.has(s));
    assert.deepEqual(unclassified, [], 'a state in no class is invisible to recovery');
  });

  it('the schema rejects a state that is not in TURN_STATE', () => {
    const id = freshTenant('check');
    const store = openTenantStore(id);
    try {
      const t = send(store);
      assert.throws(() => park(store, t.turnId, 'not_a_state'));
      assert.throws(() => park(store, t.turnId, 'running'), 'the 002 remap must stay rejected');
      for (const state of WAITING_STATES) park(store, t.turnId, state); // accepted
    } finally { store.close?.(); }
  });
});
