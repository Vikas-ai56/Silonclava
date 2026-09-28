import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { upsertScheduleMirror, predictedDurationMs } from '../src/tenant-data/cron-store.mjs';
import {
  configureWakeScheduler, resetWakeScheduler, collectDue, pumpWakes,
  completeCronWake, wakeSchedulerStats, preemptOverruns, MAX_CRON_ATTEMPTS,
} from '../src/wake-scheduler.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_coalesce_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  resetWakeScheduler();
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});
beforeEach(() => resetWakeScheduler());

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
  return { log, warm, advance: (ms) => { clock += ms; } };
}

function seedJobs(id, jobs, now) {
  const store = openTenantStore(id);
  try {
    upsertScheduleMirror(store, jobs.map(([jobId, dueInMs]) => ({
      jobId, name: jobId, enabled: true, scheduleExpr: '0 9 * * *',
      nextRunAtMs: now + dueInMs,
    })));
  } finally { store.db.close(); }
}

function writeOpenclawCron(id, jobs, now) {
  const dir = path.join(TENANTS_DIR, id, 'openclaw', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'openclaw.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (job_id TEXT PRIMARY KEY, name TEXT,
           enabled INTEGER, schedule_expr TEXT, schedule_tz TEXT, next_run_at_ms INTEGER)`);
  db.exec('DELETE FROM cron_jobs');
  const ins = db.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?,?)');
  for (const [jobId, dueInMs] of jobs) {
    ins.run(jobId, jobId, 1, '0 9 * * *', 'UTC', now + dueInMs);
  }
  db.close();
}

describe('several jobs due at once on ONE tenant', () => {
  it('wakes the container once and tracks every due job', async () => {
    const id = freshTenant('same');
    const now = Date.now();
    const h = harness([id], { now });
    seedJobs(id, [['morning', 1000], ['digest', 1000], ['sweep', 1000]], now);

    await collectDue();
    const started = await pumpWakes();

    assert.deepEqual(started, [id], 'one container wake, not three');
    assert.equal(h.log.woken.length, 1, 'the container is expensive — wake it once');
    const stats = wakeSchedulerStats();
    assert.equal(stats.queued, 0, 'no job is left stranded in the queue');
    assert.deepEqual(
      [...(stats.cronJobs?.[id] || [])].sort(),
      ['digest', 'morning', 'sweep'],
      'all three jobs must be tracked as in-flight, not just the first',
    );
  });

  it('does not hibernate while a job it woke for has still not run', async () => {
    const id = freshTenant('hib');
    const now = Date.now();
    const h = harness([id], { now });
    seedJobs(id, [['a', 1000], ['b', 1000]], now);

    await collectDue();
    await pumpWakes();
    h.advance(5000);

    writeOpenclawCron(id, [['a', 86_400_000], ['b', 1000]], now);
    const first = await completeCronWake(id);
    assert.equal(first.hibernated, false);
    assert.deepEqual(first.pending, ['b']);
    assert.deepEqual(h.log.hibernated, [],
      'job b has not run — hibernating now would kill it');

    writeOpenclawCron(id, [['a', 86_400_000], ['b', 86_400_000]], now);
    const second = await completeCronWake(id);
    assert.equal(second.hibernated, true);
    assert.deepEqual(h.log.hibernated, [id], 'last job out turns off the lights');
  });

  it('a lone job is still measured; a coalesced wake is not guessed at', async () => {
    const solo = freshTenant('solo');
    const now = Date.now();
    const h = harness([solo], { now });
    seedJobs(solo, [['only', 1000]], now);
    await collectDue();
    await pumpWakes();
    h.advance(4000);
    writeOpenclawCron(solo, [['only', 86_400_000]], now);
    await completeCronWake(solo);

    const store = openTenantStore(solo);
    try {
      const seen = predictedDurationMs(store, 'only');
      assert.equal(seen.seen, true, 'one job per wake is an attributable measurement');
    } finally { store.db.close(); }

    const pair = freshTenant('pair');
    const h2 = harness([pair], { now });
    seedJobs(pair, [['x', 1000], ['y', 1000]], now);
    await collectDue();
    await pumpWakes();
    h2.advance(4000);
    writeOpenclawCron(pair, [['x', 86_400_000], ['y', 86_400_000]], now);
    await completeCronWake(pair);

    const store2 = openTenantStore(pair);
    try {
      assert.equal(predictedDurationMs(store2, 'x').seen, false,
        'two jobs shared one wake — attributing the elapsed time to either is a guess');
    } finally { store2.db.close(); }
  });

  it('a second tenant still gets its own slot', async () => {
    const a = freshTenant('multi_a');
    const b = freshTenant('multi_b');
    const now = Date.now();
    const h = harness([a, b], { now });
    seedJobs(a, [['a1', 1000], ['a2', 1000]], now);
    seedJobs(b, [['b1', 1000]], now);

    await collectDue();
    const started = await pumpWakes();
    assert.deepEqual(started.sort(), [a, b].sort(), 'both tenants wake');
    assert.equal(h.log.woken.length, 2, 'two containers, three jobs');
  });
});

describe('the wake lead is not charged against the job', () => {
  it('a job woken early is not preempted before it is even due', async () => {
    const id = freshTenant('lead');
    const now = Date.now();
    const h = harness([id], { now });
    seedJobs(id, [['slow', 55_000]], now);

    await collectDue();
    const started = await pumpWakes();
    assert.deepEqual(started, [id], 'woken ahead of the due time, by design');

    h.advance(59_000);
    assert.deepEqual(await preemptOverruns(), [],
      'still not due — the container is early, the job has not started');

    h.advance(30_000);
    assert.deepEqual(await preemptOverruns(), [],
      'due 30s ago and inside a 60s budget: killing it here is what broke cron');

    h.advance(45_000);
    assert.deepEqual(await preemptOverruns(), [id],
      'genuinely overrunning its budget after it became due');
  });
});

describe('container acquisition is not charged to the job', () => {
  it('the budget starts when the container is ready, not when the wake was queued', async () => {
    const id = freshTenant('acquire');
    const now = Date.now();
    const warm = new Set();
    const log = { hibernated: [] };
    let clock = now;
    configureWakeScheduler({
      listTenants: async () => [{ id }],
      openStore: (t) => openTenantStore(t),
      openclawDir: (t) => path.join(TENANTS_DIR, t, 'openclaw'),
      isWarm: (t) => warm.has(t),
      warmCount: () => warm.size,
      maxWarm: () => 5,
      // A real container takes ~27s to become ready. That is the cost this
      // scheduler pays to run the job, not time the job has spent running.
      wake: async (t) => { clock += 27_000; warm.add(t); },
      hibernate: async (t) => { warm.delete(t); log.hibernated.push(t); },
      now: () => clock,
    });
    seedJobs(id, [['slow', 1000]], now);

    await collectDue();
    await pumpWakes();

    clock += 50_000;
    assert.deepEqual(await preemptOverruns(), [],
      '27s of docker start plus a 50s turn used to blow a 60s budget before the model '
      + 'had finished thinking; every cron run in production was killed this way');

    clock += 20_000;
    assert.deepEqual(await preemptOverruns(), [id],
      'a job genuinely running past its budget is still preempted');
  });
});

describe('a job that can never deliver must not thrash forever', () => {
  it('gives up after a bounded number of attempts', async () => {
    const id = freshTenant('thrash');
    const now = Date.now();
    const h = harness([id], { now });
    seedJobs(id, [['doomed', 1000]], now);

    let preempts = 0;
    for (let round = 0; round < 6; round += 1) {
      await collectDue();
      await pumpWakes();
      h.advance(10 * 60_000);
      if ((await preemptOverruns()).length) preempts += 1;
    }

    assert.ok(preempts <= MAX_CRON_ATTEMPTS, `preempted ${preempts} times, cap is ${MAX_CRON_ATTEMPTS}`);
    assert.equal(wakeSchedulerStats().queued, 0,
      'completeCronWake only runs on a successful delivery, so an undeliverable job used to '
      + 'pin its tenant in a permanent 60-second wake/kill cycle, burning a slot indefinitely');
  });
});
