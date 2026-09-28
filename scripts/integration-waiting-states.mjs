#!/usr/bin/env node
/**
 * Local integration run for the waiting states.
 *
 * Drives the real store, the real queue and the real recovery path against a
 * throwaway tenant — no Docker, no Twilio, no model. What it does NOT cover is
 * the model call itself, which is stubbed; everything below the model is the
 * production code.
 *
 *   node scripts/integration-waiting-states.mjs
 *
 * Exits non-zero on the first broken expectation.
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.ROCKY_VAULT_MASTER_KEY ||= Buffer.alloc(32, 11).toString('base64');

const { openTenantStore } = await import('../src/tenant-data/store.mjs');
const {
  recordInboundAndQueueTurn, claimNextTurn, completeTurn,
  recoverInterruptedTurns, queueDepth, hasWork, waitingDepth, turnStateCounts,
} = await import('../src/tenant-data/queue-store.mjs');
const { TURN_STATE, WAITING_STATES } = await import('../src/tenant-data/migrations.mjs');
const { TENANTS_DIR } = await import('../src/paths.mjs');

let failures = 0;
let seq = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

const TENANT = `br_itest_${process.pid}`;
const dir = path.join(TENANTS_DIR, TENANT);
fs.rmSync(dir, { recursive: true, force: true });
const store = openTenantStore(TENANT);

const user = (body) => {
  const r = recordInboundAndQueueTurn(store, {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    externalMessageId: `SM_${process.pid}_${seq++}`,
    body,
    recipient: '+6591234567',
    at: new Date().toISOString(),
  });
  console.log(`\n  user → "${body}"  (turn ${r.turnId}${r.coalescedInto ? ', joined' : ', new'})`);
  return r;
};
const claim = () => claimNextTurn(store, { runtimeId: 'rt-1', generation: 1 });
const park = (turnId, state) => {
  store.db.prepare('UPDATE turns SET state = ? WHERE id = ?').run(state, turnId);
  console.log(`  agent parks turn ${turnId} → ${state}`);
};

try {
  console.log('\n\x1b[1m1. an ordinary turn still works\x1b[0m');
  const t1 = user('hello');
  const c1 = claim();
  ok('the turn is claimed', c1?.id === t1.turnId);
  completeTurn(store, t1.turnId, { state: TURN_STATE.COMPLETED });
  ok('the turn completes', turnStateCounts(store)[TURN_STATE.COMPLETED] === 1);

  console.log('\n\x1b[1m2. THE FIX — a turn parked on a human does not block the next message\x1b[0m');
  const t2 = user('book me a flight');
  claim();
  park(t2.turnId, TURN_STATE.AWAITING_APPROVAL);

  const t3 = user('actually, what time is it?');
  ok('the new message starts its own turn', t3.turnId !== t2.turnId,
    'it must not be swallowed into the parked one');
  const c3 = claim();
  ok('and it is served while the first waits', c3?.id === t3.turnId,
    'before this slice, every later message was refused indefinitely');
  completeTurn(store, t3.turnId, { state: TURN_STATE.COMPLETED });

  console.log('\n\x1b[1m3. parked work is not backlog, but it IS visible\x1b[0m');
  ok('hasWork is false — nothing for the scheduler to pick up', hasWork(store) === false,
    `queueDepth=${queueDepth(store)}`);
  const w = waitingDepth(store);
  ok('waitingDepth answers "what is stuck on me"', w.total === 1 && w.byState[TURN_STATE.AWAITING_APPROVAL] === 1,
    JSON.stringify(w.byState));

  console.log('\n\x1b[1m4. an executing turn still blocks, as it always did\x1b[0m');
  const t4 = user('a long job');
  const c4 = claim();
  ok('claimed', c4?.id === t4.turnId);
  const t5 = user('and another');
  ok('a second turn is refused while one is executing', claim() === null,
    'one executing turn per tenant is unchanged');
  completeTurn(store, t4.turnId, { state: TURN_STATE.COMPLETED });
  // Drain the queued follow-up so the next section starts from an idle lane.
  completeTurn(store, claim().id, { state: TURN_STATE.COMPLETED });
  ok('the queued follow-up is then served', t5.turnId !== t4.turnId);

  console.log('\n\x1b[1m5. crash recovery treats each wait by what it was waiting on\x1b[0m');
  const tSub = user('spawn a child');
  park(claim().id, TURN_STATE.WAITING_SUBRUN);
  const tRetry = user('retry me');
  park(claim().id, TURN_STATE.RETRY_WAIT);

  console.log('  --- simulating a crash and reboot ---');
  const requeued = recoverInterruptedTurns(store);
  const stateOf = (id) => store.db.prepare('SELECT state FROM turns WHERE id = ?').get(id).state;
  ok('a subrun wait is requeued — its child died with the process', stateOf(tSub.turnId) === TURN_STATE.QUEUED);
  ok('a retry wait is requeued — its timer died too', stateOf(tRetry.turnId) === TURN_STATE.QUEUED);
  ok('the approval wait is left alone — the human survived the crash',
    stateOf(t2.turnId) === TURN_STATE.AWAITING_APPROVAL, 're-running would ask twice');
  ok('the recovery count reports only what it requeued', requeued === 2, `got ${requeued}`);

  console.log('\n\x1b[1m6. the schema is the backstop\x1b[0m');
  let rejected = 0;
  for (const bad of ['running', 'not_a_state', 'waiting']) {
    try { park(t1.turnId, bad); } catch { rejected += 1; }
  }
  ok('an invalid state is rejected by the CHECK constraint', rejected === 3);
  for (const s of WAITING_STATES) park(t1.turnId, s);
  ok('all three waiting states are accepted', true);
} finally {
  store.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures ? `\x1b[31m${failures} broken expectation(s)\x1b[0m` : '\x1b[32mall expectations held\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
