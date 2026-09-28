import fs from 'node:fs';
import path from 'node:path';
import { openDatabaseFileReadonly } from './open.mjs';

/**
 * Host-owned cron scheduling state (SPEC-phase3c §3a).
 *
 * Everything the wake scheduler reads comes from here — our own tables — so a
 * change to OpenClaw's internal schema degrades cron visibly (refresh stops,
 * a test fails) rather than stopping it silently (PATTERNS.md P8).
 */

const nowIso = () => new Date().toISOString();

/** First-run assumption for a job we have never seen: short. */
export const DEFAULT_DURATION_MS = 20_000;
/** Observations before an estimate stops being treated as provisional. */
export const PROVEN_AFTER = 3;
/** Weight on the newest observation. A digest grows with the user's data, so
 *  recent runs matter more than an all-time mean. */
const EWMA_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// Schedule mirror
// ---------------------------------------------------------------------------

export function upsertScheduleMirror(store, jobs) {
  const at = nowIso();
  const stmt = store.db.prepare(
    `INSERT INTO cron_schedule_mirror
       (job_id, name, schedule_expr, schedule_tz, enabled, next_run_at_ms, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       name = excluded.name,
       schedule_expr = excluded.schedule_expr,
       schedule_tz = excluded.schedule_tz,
       enabled = excluded.enabled,
       next_run_at_ms = excluded.next_run_at_ms,
       refreshed_at = excluded.refreshed_at`,
  );
  const seen = new Set();
  const run = store.db.transaction(() => {
    for (const j of jobs) {
      seen.add(j.jobId);
      stmt.run(j.jobId, j.name ?? null, j.scheduleExpr ?? null, j.scheduleTz ?? null,
        j.enabled ? 1 : 0, j.nextRunAtMs ?? null, at);
    }
    // A job deleted in the container must stop waking us.
    for (const row of store.db.prepare('SELECT job_id FROM cron_schedule_mirror').all()) {
      if (!seen.has(row.job_id)) {
        store.db.prepare('DELETE FROM cron_schedule_mirror WHERE job_id = ?').run(row.job_id);
      }
    }
  });
  run();
  return seen.size;
}

export function scheduledJobs(store) {
  return store.db
    .prepare(
      `SELECT job_id AS jobId, name, next_run_at_ms AS nextRunAtMs, refreshed_at AS refreshedAt
         FROM cron_schedule_mirror
        WHERE enabled = 1 AND next_run_at_ms IS NOT NULL
        ORDER BY next_run_at_ms`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Duration model — the host's own wake -> delivery measurement
// ---------------------------------------------------------------------------

export function predictedDurationMs(store, jobId) {
  const row = store.db
    .prepare('SELECT ewma_ms AS ewmaMs, unproven FROM cron_duration_model WHERE job_id = ?')
    .get(jobId);
  if (!row) return { ms: DEFAULT_DURATION_MS, unproven: true, seen: false };
  return { ms: row.ewmaMs, unproven: Boolean(row.unproven), seen: true };
}

export function recordDuration(store, jobId, observedMs) {
  const at = nowIso();
  const ms = Math.max(0, Math.round(observedMs));
  const run = store.db.transaction(() => {
    const cur = store.db
      .prepare('SELECT ewma_ms AS ewmaMs, observations FROM cron_duration_model WHERE job_id = ?')
      .get(jobId);
    const observations = (cur?.observations ?? 0) + 1;
    const ewma = cur ? Math.round(EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * cur.ewmaMs) : ms;
    store.db
      .prepare(
        `INSERT INTO cron_duration_model (job_id, ewma_ms, observations, unproven, last_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           ewma_ms = excluded.ewma_ms, observations = excluded.observations,
           unproven = excluded.unproven, last_ms = excluded.last_ms,
           updated_at = excluded.updated_at`,
      )
      .run(jobId, ewma, observations, observations < PROVEN_AFTER ? 1 : 0, ms, at);
    return { ewmaMs: ewma, observations };
  });
  return run();
}

// ---------------------------------------------------------------------------
// Reading the container's cron store — refresh input only, never authority
// ---------------------------------------------------------------------------

export function openclawCronDbPath(tenantOpenclawDir) {
  return path.join(tenantOpenclawDir, 'state', 'openclaw.sqlite');
}

/**
 * Read the tenant's cron jobs out of OpenClaw's own database.
 *
 * Read-only, and tolerant by design: any failure returns null so the caller
 * keeps the existing mirror rather than wiping it. A schema change upstream
 * must not delete our schedules.
 */
export function readOpenclawCronJobs(tenantOpenclawDir) {
  const file = openclawCronDbPath(tenantOpenclawDir);
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = openDatabaseFileReadonly(file);
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'")
      .get();
    if (!has) return null;
    return db
      .prepare(
        `SELECT job_id, name, enabled, schedule_expr, schedule_tz, next_run_at_ms
           FROM cron_jobs`,
      )
      .all()
      .map((r) => ({
        jobId: r.job_id,
        name: r.name,
        enabled: Boolean(r.enabled),
        scheduleExpr: r.schedule_expr,
        scheduleTz: r.schedule_tz,
        nextRunAtMs: r.next_run_at_ms,
      }));
  } catch {
    // Unreadable, locked, or reshaped: keep what we have.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/** @returns {number|null} jobs mirrored, or null when the source was unusable. */
export function refreshScheduleMirror(store, tenantOpenclawDir) {
  const jobs = readOpenclawCronJobs(tenantOpenclawDir);
  if (jobs === null) return null;
  return upsertScheduleMirror(store, jobs);
}

export function jobsNeedingWebhook(tenantOpenclawDir, expectedUrl) {
  const jobs = readOpenclawCronJobsRaw(tenantOpenclawDir);
  if (jobs === null) return null;
  return jobs
    .filter((j) => j.enabled)
    .filter((j) => j.deliveryMode !== 'webhook' || j.deliveryTo !== expectedUrl)
    .map((j) => ({ jobId: j.jobId, name: j.name, mode: j.deliveryMode, to: j.deliveryTo }));
}

function readOpenclawCronJobsRaw(tenantOpenclawDir) {
  const file = openclawCronDbPath(tenantOpenclawDir);
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = openDatabaseFileReadonly(file);
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'")
      .get();
    if (!has) return null;
    return db
      .prepare('SELECT job_id, name, enabled, delivery_mode, delivery_to FROM cron_jobs')
      .all()
      .map((r) => ({
        jobId: r.job_id,
        name: r.name,
        enabled: Boolean(r.enabled),
        deliveryMode: r.delivery_mode,
        deliveryTo: r.delivery_to,
      }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}
