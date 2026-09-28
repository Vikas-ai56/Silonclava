import {
  jobsNeedingWebhook,
  scheduledJobs,
  predictedDurationMs,
  recordDuration,
  refreshScheduleMirror,
  DEFAULT_DURATION_MS,
} from './tenant-data/cron-store.mjs';


export const WAKE_LEAD_MS = Number(process.env.ROCKY_WAKE_LEAD_MS || 60_000);
export const TICK_MS = Number(process.env.ROCKY_WAKE_TICK_MS || 30_000);
export const MAX_CRON_SLOTS = Number(process.env.ROCKY_MAX_CRON_SLOTS || 3);
export const OVERRUN_FACTOR = Number(process.env.ROCKY_CRON_OVERRUN_FACTOR || 3);
export const MAX_CRON_ATTEMPTS = Number(process.env.ROCKY_MAX_CRON_ATTEMPTS || 3);
const AGING_MS_PER_SECOND = Number(process.env.ROCKY_CRON_AGING || 50);

/** @type {WakeRequest[]} */
let queue = [];
/** @type {Map<string, {jobIds: string[], startedAt: number, predictedMs: number}>} */
const cronWarm = new Map();
/** @type {Map<string, number>} attempts per tenant+due-time, so a NEW run starts fresh */
const attemptsByRun = new Map();
let tickTimer = null;
let deps = null;

/**
 * @param {{
 *   listTenants: () => Promise<Array<{id: string}>>,
 *   openStore: (tenantId: string) => object,
 *   openclawDir: (tenantId: string) => string,
 *   isWarm: (tenantId: string) => boolean,
 *   warmCount: () => number,
 *   maxWarm: () => number,
 *   wake: (tenantId: string) => Promise<void>,
 *   hibernate: (tenantId: string) => Promise<void>,
 *   inFlight?: (tenantId: string) => boolean,
 *   now?: () => number,
 * }} wiring
 */
export function configureWakeScheduler(wiring) {
  deps = { now: () => Date.now(), inFlight: () => false, ...wiring };
}

export function resetWakeScheduler() {
  stopWakeScheduler();
  queue = [];
  cronWarm.clear();
  attemptsByRun.clear();
  deps = null;
}

/** Effective sort key: shortest predicted first, improved by time waited. */
function runKey(tenantId, dueAtMs) {
  return `${tenantId}:${dueAtMs}`;
}

function priority(req, now) {
  const waitedSec = Math.max(0, (now - req.queuedAtMs) / 1000);
  return req.predictedMs - waitedSec * AGING_MS_PER_SECOND;
}

function sortQueue(now) {
  queue.sort((a, b) => priority(a, now) - priority(b, now));
}

/** Is this tenant's container up only to run a cron job? */
export function isCronWarm(tenantId) {
  return cronWarm.has(tenantId);
}

/**
 * The admission policy took a cron container's slot. Put its job back at the
 * head so it is retried first rather than dropped — the container is stopped by
 * the caller, not here.
 */
export function requeueEvictedCronWake(tenantId) {
  const entry = cronWarm.get(tenantId);
  if (!entry) return false;
  cronWarm.delete(tenantId);
  queue.unshift({
    tenantId,
    jobIds: entry.jobIds,
    dueAtMs: deps.now(),
    predictedMs: entry.predictedMs,
    queuedAtMs: deps.now(),
  });
  return true;
}

export async function collectDue() {
  const now = deps.now();
  const horizon = now + WAKE_LEAD_MS;
  let added = 0;

  for (const tenant of await deps.listTenants()) {
    if (deps.isWarm(tenant.id)) continue;
    let store;
    try {
      store = deps.openStore(tenant.id);
    } catch {
      continue; // no database yet: nothing scheduled
    }
    try {
      if (cronWarm.has(tenant.id)) continue;
      const queued = queue.find((q) => q.tenantId === tenant.id);
      const jobIds = [];
      let predictedMs = 0;
      let dueAtMs = Infinity;
      for (const job of scheduledJobs(store)) {
        if (job.nextRunAtMs > horizon) break; // ordered by next run
        if (queued?.jobIds.includes(job.jobId)) continue;
        jobIds.push(job.jobId);
        predictedMs += predictedDurationMs(store, job.jobId).ms;
        dueAtMs = Math.min(dueAtMs, job.nextRunAtMs);
      }
      if (jobIds.length === 0) continue;
      if ((attemptsByRun.get(runKey(tenant.id, dueAtMs)) ?? 0) >= MAX_CRON_ATTEMPTS) continue;
      if (queued) {
        queued.jobIds.push(...jobIds);
        queued.predictedMs += predictedMs;
        queued.dueAtMs = Math.min(queued.dueAtMs, dueAtMs);
      } else {
        queue.push({ tenantId: tenant.id, jobIds, dueAtMs, predictedMs, queuedAtMs: now });
      }
      added += jobIds.length;
    } finally {
      try {
        store.db.close();
      } catch {
        /* already closed */
      }
    }
  }
  sortQueue(now);
  return added;
}

/** Admit queued wakes up to the cron slot budget and the global warm ceiling. */
export async function pumpWakes() {
  const started = [];
  while (
    cronWarm.size < MAX_CRON_SLOTS &&
    deps.warmCount() < deps.maxWarm() &&
    queue.length > 0
  ) {
    const req = queue.shift();
    if (deps.isWarm(req.tenantId)) continue; // became warm for a user meanwhile
    const entry = {
      jobIds: [...req.jobIds],
      startedAt: deps.now(),
      dueAtMs: req.dueAtMs,
      predictedMs: req.predictedMs,
      attempt: req.attempt ?? 0,
    };
    cronWarm.set(req.tenantId, entry);
    try {
      await deps.wake(req.tenantId);
      entry.startedAt = deps.now();
      await reconcileCronWebhooks(req.tenantId).catch(() => {});
      started.push(req.tenantId);
    } catch (err) {
      cronWarm.delete(req.tenantId);
      console.error(`[wake] could not wake ${req.tenantId}:`, err?.message || err);
    }
  }
  return started;
}

export async function reconcileCronWebhooks(tenantId) {
  const { cronWebhookUrlFor } = await import('./config.mjs');
  const { reconcileCronDelivery } = await import('./openclaw/docker-gateway.mjs');
  const webhookUrl = cronWebhookUrlFor(tenantId);
  const pending = jobsNeedingWebhook(deps.openclawDir(tenantId), webhookUrl);
  if (!pending || pending.length === 0) return [];
  console.warn(
    `[cron] ${tenantId}: ${pending.length} job(s) not delivering to Rocky ` +
      `(${pending.map((p) => `${p.name}:${p.mode || 'none'}`).join(', ')}) — rewriting`,
  );
  return reconcileCronDelivery(tenantId, webhookUrl, pending.map((p) => p.jobId));
}

function stillDue(store, jobIds, now) {
  const due = new Set(
    scheduledJobs(store).filter((j) => j.nextRunAtMs <= now).map((j) => j.jobId),
  );
  return jobIds.filter((id) => due.has(id));
}

export async function completeCronWake(tenantId, options = {}) {
  const entry = cronWarm.get(tenantId);
  if (!entry) return null;
  const elapsed = deps.now() - entry.startedAt;

  let pending = [];
  let store = null;
  try {
    store = deps.openStore(tenantId);
    if (options.measured !== false && entry.jobIds.length === 1) {
      recordDuration(store, entry.jobIds[0], elapsed);
    }
    const refreshed = refreshScheduleMirror(store, deps.openclawDir(tenantId));
    pending = refreshed === null ? [] : stillDue(store, entry.jobIds, deps.now());
    await reconcileCronWebhooks(tenantId).catch(() => {});
  } catch (err) {
    console.warn(`[wake] post-run bookkeeping failed for ${tenantId}:`, err?.message || err);
  } finally {
    try {
      store?.db.close();
    } catch {
      /* already closed */
    }
  }

  if (pending.length > 0) {
    return { tenantId, jobIds: entry.jobIds, pending, elapsedMs: elapsed, hibernated: false };
  }

  cronWarm.delete(tenantId);
  attemptsByRun.delete(runKey(tenantId, entry.dueAtMs ?? entry.startedAt));
  if (options.hibernate !== false) {
    await deps.hibernate(tenantId).catch((err) =>
      console.warn(`[wake] hibernate failed for ${tenantId}:`, err?.message || err),
    );
  }
  return { tenantId, jobIds: entry.jobIds, pending: [], elapsedMs: elapsed, hibernated: true };
}

export async function preemptOverruns() {
  const now = deps.now();
  const preempted = [];
  for (const [tenantId, entry] of [...cronWarm]) {
    const budget = Math.max(entry.predictedMs, DEFAULT_DURATION_MS) * OVERRUN_FACTOR;
    const runningSince = Math.max(entry.startedAt, entry.dueAtMs ?? entry.startedAt);
    if (now - runningSince <= budget) continue;
    const key = runKey(tenantId, entry.dueAtMs ?? entry.startedAt);
    const attempt = (attemptsByRun.get(key) ?? 0) + 1;
    attemptsByRun.set(key, attempt);
    cronWarm.delete(tenantId);

    if (attempt >= MAX_CRON_ATTEMPTS) {
      console.error(
        `[wake] cron ${entry.jobIds.join(',')} on ${tenantId} exceeded ${budget}ms on attempt ` +
          `${attempt} — giving up rather than thrashing. The job stays scheduled; it will be ` +
          'retried at its next due time.',
      );
      if (!deps.inFlight(tenantId)) await deps.hibernate(tenantId).catch(() => { });
      preempted.push(tenantId);
      continue;
    }

    console.warn(
      `[wake] cron ${entry.jobIds.join(',')} on ${tenantId} exceeded ${budget}ms ` +
        `— preempting and re-queueing (attempt ${attempt}/${MAX_CRON_ATTEMPTS})`,
    );
    queue.push({
      tenantId,
      jobIds: entry.jobIds,
      dueAtMs: entry.dueAtMs ?? now,
      predictedMs: entry.predictedMs,
      queuedAtMs: now,
      attempt,
    });
    if (deps.inFlight(tenantId)) {
      console.warn(
        `[wake] ${tenantId} has interactive work in flight — cron re-queued, container left running`,
      );
      preempted.push(tenantId);
      continue;
    }
    await deps.hibernate(tenantId).catch(() => { });
    preempted.push(tenantId);
  }
  if (preempted.length) sortQueue(now);
  return preempted;
}

export async function tickOnce() {
  await preemptOverruns();
  const due = await collectDue();
  const started = await pumpWakes();
  return { due, started };
}

export function startWakeScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tickOnce().catch((err) => console.error('[wake] tick failed:', err?.message || err));
  }, TICK_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
}

export function stopWakeScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

export function wakeSchedulerStats() {
  return {
    queued: queue.length,
    cronWarm: [...cronWarm.keys()],
    cronSlots: MAX_CRON_SLOTS,
    next: queue[0]
      ? {
        tenantId: queue[0].tenantId,
        jobs: queue[0].jobIds.length,
        predictedMs: queue[0].predictedMs,
      }
      : null,
    cronJobs: Object.fromEntries([...cronWarm].map(([id, e]) => [id, [...e.jobIds]])),
  };
}
