import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn,
  claimNextTurn,
  completeTurn,
  StaleTurnResultError,
} from '../src/tenant-data/queue-store.mjs';
import {
  saveResponse,
  beginSend,
  markDeliveryUnknown,
  applyProviderStatus,
  recordSendResult,
} from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_cas_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function seed(store) {
  recordInboundAndQueueTurn(store, {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    externalMessageId: `SMin_${Math.random().toString(16).slice(2)}`,
    body: 'hello',
    recipient: '+6591234567',
    at: new Date().toISOString(),
  });
  return claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
}

/** Simulate another writer moving the turn out from under us. */
function forceState(store, turnId, state) {
  store.db.prepare('UPDATE turns SET state = ? WHERE id = ?').run(state, turnId);
}

describe('a state transition asserts the state it was planned against', () => {
  it('beginSend that loses the race writes no delivery_attempts row', () => {
    const id = freshTenant('begin');
    const store = openTenantStore(id);
    try {
      const turn = seed(store);
      const saved = saveResponse(store, turn.id, 'committed bytes');

      // Another writer starts the send first.
      forceState(store, turn.id, TURN_STATE.SEND_STARTED);

      const attempt = beginSend(store, turn.id, saved.messageId);
      assert.equal(attempt, null, 'a lost claim must report itself');

      const rows = store.db
        .prepare('SELECT COUNT(*) c FROM delivery_attempts WHERE outbound_message_id = ?')
        .get(saved.messageId).c;
      assert.equal(rows, 0, 'an orphan sending row must not be committed');
    } finally { store.close?.(); }
  });

  it('beginSend that wins writes exactly one attempt', () => {
    const id = freshTenant('begin2');
    const store = openTenantStore(id);
    try {
      const turn = seed(store);
      const saved = saveResponse(store, turn.id, 'committed bytes');
      assert.equal(beginSend(store, turn.id, saved.messageId), 1);
      // A second call now loses, because the turn already moved.
      assert.equal(beginSend(store, turn.id, saved.messageId), null);
      const rows = store.db
        .prepare('SELECT COUNT(*) c FROM delivery_attempts WHERE outbound_message_id = ?')
        .get(saved.messageId).c;
      assert.equal(rows, 1, 'the losing call must not add a second attempt');
    } finally { store.close?.(); }
  });

  it('every turn-state write names its expected prior state', () => {
    // better-sqlite3 is synchronous, so a transaction already makes read-then-write
    // atomic within this process — the race this guards against is the CLI opening
    // the same database as a second writer, which cannot be staged in one process.
    // So assert the invariant in the source, the way this repo asserts its other
    // structural rules.
    const dir = path.join(process.cwd(), 'src', 'tenant-data');
    const offenders = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      // applyProviderStatus is the one deliberate exemption: it exists to correct
      // a record after the fact, so a prior-state predicate would disable it.
      const body = raw.split('export function applyProviderStatus')[0];
      for (const m of body.matchAll(/UPDATE turns\s+SET state[\s\S]{0,220}?`/g)) {
        // `AND state =` for a row update; `WHERE state =` or `WHERE state IN (`
        // for a set-based sweep. All three name the prior state.
        if (!/(?:AND|WHERE)\s+state\s*(?:=|IN\s*\()/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 70).replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(offenders, [], 'a turn-state write without a prior-state predicate');
  });

  it('markDeliveryUnknown does not overwrite a turn a callback already settled', () => {
    const id = freshTenant('unknown');
    const store = openTenantStore(id);
    try {
      const turn = seed(store);
      const saved = saveResponse(store, turn.id, 'bytes');
      const attempt = beginSend(store, turn.id, saved.messageId);
      forceState(store, turn.id, TURN_STATE.COMPLETED);

      markDeliveryUnknown(store, turn.id, saved.messageId, attempt, 'SEND_ERROR');
      const now = store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id).state;
      assert.equal(now, TURN_STATE.COMPLETED, 'a settled turn must not become ambiguous');
    } finally { store.close?.(); }
  });
});

describe('the correction path is deliberately not guarded', () => {
  it('a late delivered callback still rescues a delivery_unknown turn', () => {
    const id = freshTenant('correct');
    const store = openTenantStore(id);
    try {
      const turn = seed(store);
      const saved = saveResponse(store, turn.id, 'bytes');
      const attempt = beginSend(store, turn.id, saved.messageId);
      recordSendResult(store, turn.id, saved.messageId, attempt, {
        ok: true, providerMessageId: 'SMlate', status: 'queued',
      });
      markDeliveryUnknown(store, turn.id, saved.messageId, attempt, 'NO_RECEIPT');
      assert.equal(
        store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id).state,
        TURN_STATE.DELIVERY_UNKNOWN,
      );

      // This is why applyProviderStatus carries no prior-state predicate.
      const res = applyProviderStatus(store, { providerMessageId: 'SMlate', status: 'delivered' });
      assert.equal(res.applied, true);
      assert.equal(
        store.db.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id).state,
        TURN_STATE.COMPLETED,
        'the correction path must survive the CAS work',
      );
    } finally { store.close?.(); }
  });
});

describe('a genuine second-writer race', () => {
  // bin/tenant.mjs opens the same tenant database, so this is not theoretical.
  it('aborts the transaction and is reported as a stale result, not a driver error', () => {
    const id = freshTenant('race');
    const store = openTenantStore(id);
    const other = new Database(path.join(TENANTS_DIR, id, 'data', 'tenant.sqlite'));
    try {
      const turn = seed(store);

      // Wedge a competing commit between completeTurn's read and its write.
      const realGet = store.db.prepare('SELECT * FROM turns WHERE id = ?');
      let fired = false;
      const spy = {
        get: (...a) => {
          const row = realGet.get(...a);
          if (!fired) {
            fired = true;
            other.prepare('UPDATE turns SET state = ? WHERE id = ?')
              .run(TURN_STATE.RESPONSE_SAVED, turn.id);
          }
          return row;
        },
      };
      const realPrepare = store.db.prepare.bind(store.db);
      store.db.prepare = (sql) => (sql.includes('SELECT * FROM turns WHERE id = ?') ? spy : realPrepare(sql));

      let thrown;
      try {
        completeTurn(store, turn.id, { state: TURN_STATE.COMPLETED });
      } catch (e) { thrown = e; }
      store.db.prepare = realPrepare;

      assert.ok(thrown, 'the race must not pass silently');
      assert.ok(
        thrown instanceof StaleTurnResultError,
        `callers catch StaleTurnResultError; got ${thrown?.name} ${thrown?.code}`,
      );
      // The other writer's state survives — we did not overwrite it.
      assert.equal(
        other.prepare('SELECT state FROM turns WHERE id = ?').get(turn.id).state,
        TURN_STATE.RESPONSE_SAVED,
      );
    } finally { other.close(); store.close?.(); }
  });
});
