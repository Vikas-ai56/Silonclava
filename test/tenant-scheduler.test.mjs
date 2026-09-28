import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn,
  claimNextTurn,
  completeTurn,
  recoverInterruptedTurns,
  turnMessageIds,
  queueDepth,
} from '../src/tenant-data/queue-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import {
  enqueueForTenant,
  configureScheduler,
  schedulerStats,
  recoverTenantLane,
  resetScheduler,
} from '../src/inbound-queue.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_sch_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => resetScheduler());
after(() => {
  resetScheduler();
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function inbound(body, external = null) {
  return {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    externalMessageId: external,
    body,
  };
}

describe('durable queue store', () => {
  it('coalesces into a pending turn while keeping every message ordered', () => {
    const id = freshTenant('coalesce');
    const store = openTenantStore(id);
    try {
      const a = recordInboundAndQueueTurn(store, inbound('first'));
      const b = recordInboundAndQueueTurn(store, inbound('second'));
      const c = recordInboundAndQueueTurn(store, inbound('third'));

      assert.equal(b.coalescedInto, true);
      assert.equal(c.turnId, a.turnId, 'all three should share one turn');

      // Every source message still has its own ordered ledger row.
      const rows = store.db
        .prepare('SELECT sequence, body_cipher FROM messages ORDER BY sequence')
        .all();
      assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3]);
      assert.deepEqual(
        rows.map((r) => decryptBody(id, r.body_cipher)),
        ['first', 'second', 'third'],
      );
      assert.equal(turnMessageIds(store, a.turnId).length, 3);
    } finally {
      store.db.close();
    }
  });

  it('does not join a turn that is already running', () => {
    const id = freshTenant('nojoin');
    const store = openTenantStore(id);
    try {
      const first = recordInboundAndQueueTurn(store, inbound('one'));
      const claimed = claimNextTurn(store);
      assert.equal(claimed.id, first.turnId);

      const later = recordInboundAndQueueTurn(store, inbound('two'));
      assert.equal(later.coalescedInto, false);
      assert.notEqual(later.turnId, first.turnId);

      // One active turn per tenant: nothing else may be claimed yet.
      assert.equal(claimNextTurn(store), null);
      completeTurn(store, claimed.id, { state: TURN_STATE.COMPLETED });
      assert.equal(claimNextTurn(store).id, later.turnId);
    } finally {
      store.db.close();
    }
  });

  it('treats a provider retry as the same message, not a new turn', () => {
    const id = freshTenant('dedupe');
    const store = openTenantStore(id);
    try {
      const first = recordInboundAndQueueTurn(store, inbound('hello', 'SM123'));
      const retry = recordInboundAndQueueTurn(store, inbound('hello', 'SM123'));
      assert.equal(retry.deduped, true);
      assert.equal(retry.turnId, null);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns').get().n, 1);
      assert.equal(first.deduped, false);
    } finally {
      store.db.close();
    }
  });

  it('returns a crashed turn to queued so it is re-executed in full', () => {
    const id = freshTenant('recover');
    const store = openTenantStore(id);
    try {
      recordInboundAndQueueTurn(store, inbound('work'));
      const claimed = claimNextTurn(store);
      assert.equal(claimed.state, TURN_STATE.CLAIMED);

      // Simulate a crash: the process dies with the turn still running.
      assert.equal(recoverInterruptedTurns(store), 1);
      const again = claimNextTurn(store);
      assert.equal(again.id, claimed.id);
      assert.equal(again.attempt, 2, 'attempt should increment on re-execution');
      assert.equal(queueDepth(store), 1);
    } finally {
      store.db.close();
    }
  });
});

describe('scheduler lanes', () => {
  it('keys lanes on tenant id, not on the sender alias', async () => {
    const id = freshTenant('alias');
    const seen = [];
    configureScheduler({
      runTurn: async ({ tenantId }) => {
        seen.push(tenantId);
        return { state: TURN_STATE.COMPLETED };
      },
    });

    // Same tenant reached through two different channel addresses.
    enqueueForTenant(id, { ...inbound('via jid'), channelAccount: '6591234567@s.whatsapp.net' });
    await settle();
    enqueueForTenant(id, { ...inbound('via phone'), channelAccount: '+6591234567' });
    await settle();

    assert.deepEqual(seen, [id, id]);
    assert.equal(Object.keys(schedulerStats().tenants).length, 1, 'one lane for one tenant');
  });

  it('runs one turn at a time per tenant', async () => {
    const id = freshTenant('serial');
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];
    configureScheduler({
      runTurn: async ({ store, turn }) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(turn.id);
        await new Promise((r) => setTimeout(r, 20));
        concurrent -= 1;
        return { state: TURN_STATE.COMPLETED };
      },
    });

    enqueueForTenant(id, inbound('a'));
    await settle();
    enqueueForTenant(id, inbound('b'));
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(maxConcurrent, 1, 'a tenant must never run two turns at once');
    assert.equal(order.length, 2);
    assert.ok(order[0] < order[1], 'turns run in FIFO order');
  });

  it('caps concurrent tenants with the global semaphore', async () => {
    const tenantIds = ['s1', 's2', 's3', 's4', 's5'].map((t) => freshTenant(t));
    let concurrent = 0;
    let maxConcurrent = 0;
    configureScheduler({
      maxConcurrent: 2,
      runTurn: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return { state: TURN_STATE.COMPLETED };
      },
    });

    for (const id of tenantIds) enqueueForTenant(id, inbound('go'));
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(maxConcurrent, 2, `semaphore breached: ${maxConcurrent}`);
    const stats = schedulerStats();
    assert.equal(stats.active, 0, 'all work should have drained');
    for (const id of tenantIds) assert.equal(stats.tenants[id].depth, 0, `${id} not drained`);
  });

  it('does not let one busy tenant starve the others', async () => {
    const busy = freshTenant('busy');
    const others = ['o1', 'o2', 'o3'].map((t) => freshTenant(t));
    const served = new Set();
    configureScheduler({
      maxConcurrent: 1,
      runTurn: async ({ tenantId }) => {
        served.add(tenantId);
        await new Promise((r) => setTimeout(r, 15));
        return { state: TURN_STATE.COMPLETED };
      },
    });

    for (let i = 0; i < 5; i += 1) enqueueForTenant(busy, inbound(`busy ${i}`));
    for (const id of others) enqueueForTenant(id, inbound('please'));
    await new Promise((r) => setTimeout(r, 600));

    for (const id of others) assert.ok(served.has(id), `${id} was starved`);
  });

  it('keeps the turn durable when the handler throws', async () => {
    const id = freshTenant('fail');
    configureScheduler({
      runTurn: async () => {
        throw new Error('model unavailable');
      },
    });
    enqueueForTenant(id, inbound('boom'));
    await new Promise((r) => setTimeout(r, 80));

    const store = openTenantStore(id);
    try {
      const turn = store.db.prepare('SELECT state, error_code FROM turns').get();
      assert.equal(turn.state, 'failed');
      // The original request survives, which is what total re-execution needs.
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
    } finally {
      store.db.close();
    }
  });

  it('recovers a lane interrupted by a restart', async () => {
    const id = freshTenant('restart');
    // A previous process left a turn running.
    const pre = openTenantStore(id);
    recordInboundAndQueueTurn(pre, inbound('survive the restart'));
    claimNextTurn(pre);
    pre.db.close();

    const ran = [];
    configureScheduler({
      runTurn: async ({ store, turn }) => {
        const [messageId] = turnMessageIds(store, turn.id);
        const row = store.db.prepare('SELECT body_cipher FROM messages WHERE id = ?').get(messageId);
        ran.push(decryptBody(id, row.body_cipher));
        return { state: TURN_STATE.COMPLETED };
      },
    });

    assert.equal(recoverTenantLane(id), 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(ran, ['survive the restart']);
  });
});
