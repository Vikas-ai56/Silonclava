import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import {
  upsertScheduleMirror, scheduledJobs, recordDuration, predictedDurationMs,
  refreshScheduleMirror, DEFAULT_DURATION_MS, PROVEN_AFTER,
} from '../src/tenant-data/cron-store.mjs';
import {
  configureWakeScheduler, resetWakeScheduler, collectDue, pumpWakes,
  completeCronWake, preemptOverruns, requeueEvictedCronWake, tickOnce,
  wakeSchedulerStats, MAX_CRON_SLOTS,
} from '../src/wake-scheduler.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_wake_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  resetWakeScheduler();
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});
beforeEach(() => resetWakeScheduler());

/** A harness that records wake/hibernate instead of touching Docker. */
function harness(tenantIds, opts = {}) {
  const warm = new Set(opts.warm || []);
  const log = { woken: [], hibernated: [] };
  let clock = opts.now || Date.now();
  configureWakeScheduler({
    listTenants: async () => tenantIds.map((id) => ({ id })),
    openStore: (id) => openTenantStore(id),
    openclawDir: (id) => path.join(TENANTS_DIR, id, 'openclaw'),
    isWarm: (id) => warm.has(id),
    warmCount: () => warm.size,
    maxWarm: () => opts.maxWarm ?? 5,
    wake: async (id) => { warm.add(id); log.woken.push(id); },
    hibernate: async (id) => { warm.delete(id); log.hibernated.push(id); },
    now: () => clock,
  });
  return { log, warm, advance: (ms) => { clock += ms; }, now: () => clock };
}

function seedJob(id, jobId, dueInMs, now = Date.now()) {
  const store = openTenantStore(id);
  try {
    upsertScheduleMirror(store, [{
      jobId, name: jobId, enabled: true, scheduleExpr: '0 9 * * *',
      nextRunAtMs: now + dueInMs,
    }]);
  } finally { store.db.close(); }
}

describe('schedule mirror (P8)', () => {
  it('stores and lists due jobs, and drops jobs deleted upstream', () => {
    const id = freshTenant('mirror');
    const store = openTenantStore(id);
    try {
      upsertScheduleMirror(store, [
        { jobId: 'a', enabled: true, nextRunAtMs: 2000 },
        { jobId: 'b', enabled: true, nextRunAtMs: 1000 },
      ]);
      assert.deepEqual(scheduledJobs(store).map((j) => j.jobId), ['b', 'a']);

      // 'a' was deleted in the container: it must stop waking us.
      upsertScheduleMirror(store, [{ jobId: 'b', enabled: true, nextRunAtMs: 1000 }]);
      assert.deepEqual(scheduledJobs(store).map((j) => j.jobId), ['b']);
    } finally { store.db.close(); }
  });

  it('keeps the existing mirror when OpenClaw state is unreadable', () => {
    const id = freshTenant('p8');
    const store = openTenantStore(id);
    try {
      upsertScheduleMirror(store, [{ jobId: 'keep', enabled: true, nextRunAtMs: 5000 }]);
      // No OpenClaw database at all — the P8 failure mode.
      const result = refreshScheduleMirror(store, path.join(TENANTS_DIR, id, 'openclaw'));
      assert.equal(result, null, 'unreadable source must report null, not wipe');
      assert.deepEqual(
        scheduledJobs(store).map((j) => j.jobId),
        ['keep'],
        'wakes must keep scheduling from the last known mirror',
      );
    } finally { store.db.close(); }
  });
});

describe('duration model', () => {
  it('assumes short for an unseen job, then converges on observation', () => {
    const id = freshTenant('duration');
    const store = openTenantStore(id);
    try {
      const first = predictedDurationMs(store, 'j1');
      assert.equal(first.ms, DEFAULT_DURATION_MS);
      assert.equal(first.unproven, true);
      assert.equal(first.seen, false);

      recordDuration(store, 'j1', 60_000);
      assert.equal(predictedDurationMs(store, 'j1').ms, 60_000, 'first observation sets the baseline');

      // EWMA moves toward new evidence without jumping to it.
      recordDuration(store, 'j1', 20_000);
      const after = predictedDurationMs(store, 'j1').ms;
      assert.ok(after < 60_000 && after > 20_000, `expected smoothing, got ${after}`);
    } finally { store.db.close(); }
  });

  it('stays unproven until enough observations', () => {
    const id = freshTenant('unproven');
    const store = openTenantStore(id);
    try {
      for (let i = 1; i < PROVEN_AFTER; i += 1) {
        recordDuration(store, 'j', 1000);
        assert.equal(predictedDurationMs(store, 'j').unproven, true, `run ${i}`);
      }
      recordDuration(store, 'j', 1000);
      assert.equal(predictedDurationMs(store, 'j').unproven, false);
    } finally { store.db.close(); }
  });
});

describe('wake queue', () => {
  it('wakes a hibernated tenant whose job is due within the lead window', async () => {
    const id = freshTenant('due');
    openTenantStore(id).db.close();
    seedJob(id, 'j1', 10_000);
    const h = harness([id]);
    const { due, started } = await tickOnce();
    assert.equal(due, 1);
    assert.deepEqual(started, [id]);
    assert.deepEqual(h.log.woken, [id]);
  });

  it('does not wake, or spend a cron slot on, a tenant already warm', async () => {
    const id = freshTenant('alreadywarm');
    openTenantStore(id).db.close();
    seedJob(id, 'j1', 5_000);
    const h = harness([id], { warm: [id] });
    await tickOnce();
    assert.deepEqual(h.log.woken, [], 'a warm tenant fires its own job');
    assert.deepEqual(wakeSchedulerStats().cronWarm, []);
  });

  it('ignores jobs beyond the lead window', async () => {
    const id = freshTenant('far');
    openTenantStore(id).db.close();
    seedJob(id, 'j1', 10 * 60_000);
    harness([id]);
    assert.equal(await collectDue(), 0);
  });

  it('never exceeds the cron slot budget', async () => {
    const tenants = Array.from({ length: 8 }, (_, i) => freshTenant(`slot${i}`));
    for (const id of tenants) { openTenantStore(id).db.close(); seedJob(id, 'j', 1000); }
    const h = harness(tenants, { maxWarm: 5 });
    await tickOnce();
    assert.equal(h.log.woken.length, MAX_CRON_SLOTS, `woke ${h.log.woken.length}, budget ${MAX_CRON_SLOTS}`);
    assert.equal(wakeSchedulerStats().cronWarm.length, MAX_CRON_SLOTS);
    assert.ok(wakeSchedulerStats().queued > 0, 'the rest must stay queued');
  });

  it('runs shortest predicted job first', async () => {
    const slow = freshTenant('slow');
    const fast = freshTenant('fast');
    for (const id of [slow, fast]) { openTenantStore(id).db.close(); }
    const s1 = openTenantStore(slow);
    recordDuration(s1, 'j', 300_000); recordDuration(s1, 'j', 300_000); recordDuration(s1, 'j', 300_000);
    s1.db.close();
    const s2 = openTenantStore(fast);
    recordDuration(s2, 'j', 5_000); recordDuration(s2, 'j', 5_000); recordDuration(s2, 'j', 5_000);
    s2.db.close();
    seedJob(slow, 'j', 1000);
    seedJob(fast, 'j', 1000);

    const h = harness([slow, fast], { maxWarm: 5 });
    await collectDue();
    assert.equal(wakeSchedulerStats().next.tenantId, fast, 'shortest predicted job must lead');
  });
});

describe('preemption', () => {
  it('preempts an overrunning job and re-queues it without marking it failed', async () => {
    const id = freshTenant('overrun');
    openTenantStore(id).db.close();
    seedJob(id, 'j1', 1000);
    const h = harness([id]);
    await tickOnce();
    assert.deepEqual(h.log.woken, [id]);

    h.advance(20 * 60_000); // far beyond 3x the default estimate
    const preempted = await preemptOverruns();
    assert.deepEqual(preempted, [id]);
    assert.deepEqual(h.log.hibernated, [id]);
    assert.equal(wakeSchedulerStats().queued, 1, 're-queued, not dropped');
  });

  it('yields a cron slot to interactive work and retries the victim first', async () => {
    const cronTenants = [freshTenant('c1'), freshTenant('c2'), freshTenant('c3')];
    const user = freshTenant('user');
    for (const id of cronTenants) { openTenantStore(id).db.close(); seedJob(id, 'j', 1000); }
    openTenantStore(user).db.close();

    const h = harness([...cronTenants, user], { maxWarm: 3 });
    await tickOnce();
    assert.equal(h.warm.size, 3, 'saturated by cron');

    // Eviction itself moved to the admission policy (2026-09-21). What the
    // scheduler still owns is the guarantee that an evicted job is not lost.
    const victim = [...cronTenants].find((id) => h.warm.has(id));
    assert.ok(victim, 'expected a cron container to be warm');
    assert.equal(requeueEvictedCronWake(victim), true);
    assert.equal(wakeSchedulerStats().next.tenantId, victim, 'retried first, not starved');
    assert.equal(requeueEvictedCronWake('never-warm'), false);
  });



});

describe('completing a cron wake', () => {
  it('measures wake to delivery, refreshes the mirror, then hibernates', async () => {
    const id = freshTenant('complete');
    openTenantStore(id).db.close();
    seedJob(id, 'j1', 1000);
    const h = harness([id]);
    await tickOnce();

    h.advance(45_000);
    const result = await completeCronWake(id);
    assert.deepEqual(result.jobIds, ['j1']);
    assert.equal(result.elapsedMs, 45_000, 'slot occupancy is wake -> delivery');
    assert.deepEqual(h.log.hibernated, [id]);

    const store = openTenantStore(id);
    try {
      // The measurement must be the host's own, not read from OpenClaw.
      assert.equal(predictedDurationMs(store, 'j1').ms, 45_000);
    } finally { store.db.close(); }
    assert.deepEqual(wakeSchedulerStats().cronWarm, [], 'slot released');
  });
});
