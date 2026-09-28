/**
 * Per-tenant FIFO scheduling with a global concurrency semaphore
 * (SPEC-phase3c §5).
 *
 * Replaces the memory-only, phone-keyed lane this module used to be. Two
 * differences matter:
 *
 *  - Lanes are keyed by resolved `tenant.id`. Phone and JID forms are aliases
 *    of one tenant and must not open separate lanes, which the old
 *    digits-of-the-sender key allowed.
 *  - The in-memory map is only a wake-up optimization. Queue state lives in the
 *    tenant database, so a restart recovers it.
 */

import { openTenantStore } from './tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn,
  claimNextTurn,
  completeTurn,
  StaleTurnResultError,
  recoverInterruptedTurns,
  markSendStartedUnknown,
  markOneSendStartedUnknown,
  staleSendStartedTurns,
  queueDepth,
  hasWork,
} from './tenant-data/queue-store.mjs';
import { TURN_STATE } from './tenant-data/migrations.mjs';
import {
  acquireTenantRuntime,
  releaseTenantRuntime,
  isCurrentGeneration,
  stopTenantGateway,
} from './openclaw/tenant-gateway.mjs';

const DEFAULT_MAX_CONCURRENT_TENANTS = 4;

/**
 * A turn that exceeds this records an alert and requests cancellation. It does
 * **not** free the lane (§5): the original work may still be running inside the
 * container, and releasing the lane would let a second turn interleave with it.
 * The lane is freed only once the work settles or its gateway is terminated.
 */
const TURN_TIMEOUT_MS = Number(process.env.ROCKY_INBOUND_TURN_TIMEOUT_MS || 180_000);

/** @type {Map<string, {store: object, running: boolean, waking: boolean, lastStartedAt: number}>} */
const lanes = new Map();

let maxConcurrent = Number(process.env.ROCKY_MAX_CONCURRENT_TENANTS || DEFAULT_MAX_CONCURRENT_TENANTS);
let active = 0;
/** Tenants waiting for a slot. FIFO by readiness, so one busy tenant cannot
 *  starve the others out of the semaphore. */
const readyQueue = [];
let runTurn = null;

/**
 * Draining stops the scheduler claiming new turns without disturbing work
 * already in flight (SPEC-phase3c §8 steps 1-2).
 */
let draining = false;

export function beginDrain() {
  draining = true;
  return { active, queued: readyQueue.length };
}

export function isDraining() {
  return draining;
}

/** Wait for in-flight turns to settle, up to the grace period (§8 step 3). */
export async function drainActiveTurns(graceMs) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { remaining: active, timedOut: active > 0 };
}

/**
 * Classify whatever did not settle (§8 step 4).
 *
 * A turn still before `response_saved` is requeued for full re-execution — no
 * response was committed, so nothing was sent. A turn that had started sending
 * is `delivery_unknown`: the provider may already have delivered it, so it must
 * never be blindly resent.
 */
/** Set at boot from the org registry; gates automatic re-execution (§6). */
let writeToolsEnabled = false;

export function setWriteToolsEnabled(value) {
  writeToolsEnabled = Boolean(value);
}

export function classifyUnresolvedTurns() {
  const out = { requeued: 0, unknown: 0 };
  for (const [tenantId, entry] of lanes) {
    try {
      out.requeued += recoverInterruptedTurns(entry.store, { writesEnabled: writeToolsEnabled });
      out.unknown += markSendStartedUnknown(entry.store, 'SHUTDOWN');
    } catch (err) {
      console.warn(`[scheduler] could not classify turns for ${tenantId}:`, err?.message || err);
    }
  }
  return out;
}

/** Checkpoint and close every tenant database this process holds (§8 step 5). */
export function closeTenantStores() {
  let closed = 0;
  for (const [tenantId, entry] of lanes) {
    try {
      entry.store.db.pragma('wal_checkpoint(TRUNCATE)');
      entry.store.db.close();
      closed += 1;
    } catch (err) {
      console.warn(`[scheduler] close failed for ${tenantId}:`, err?.message || err);
    }
  }
  lanes.clear();
  return closed;
}

export function configureScheduler(options = {}) {
  if (options.maxConcurrent != null) maxConcurrent = Number(options.maxConcurrent);
  if (options.runTurn) runTurn = options.runTurn;
}

function lane(tenantId) {
  let entry = lanes.get(tenantId);
  if (!entry) {
    entry = { store: openTenantStore(tenantId), running: false, waking: false, lastStartedAt: 0 };
    lanes.set(tenantId, entry);
  }
  return entry;
}

/** Enqueue durably, then wake the lane. The database write is what makes the
 *  message survive a crash between here and the worker. */
export function enqueueForTenant(tenantId, inbound) {
  const entry = lane(tenantId);
  const result = recordInboundAndQueueTurn(entry.store, inbound);
  if (!result.deduped) wake(tenantId);
  return result;
}

function wake(tenantId) {
  const entry = lane(tenantId);
  if (entry.running || entry.waking) return;
  if (readyQueue.includes(tenantId)) return;
  entry.waking = true;
  readyQueue.push(tenantId);
  queueMicrotask(pump);
}

function pump() {
  if (draining) return; // §8 step 2: stop claiming queued turns
  while (active < maxConcurrent && readyQueue.length) {
    const tenantId = readyQueue.shift();
    const entry = lanes.get(tenantId);
    if (!entry) continue;
    entry.waking = false;
    if (entry.running) continue;
    // Stamp the runtime onto the turn at acquire so a late reply from a
    // replaced container can be rejected at completion.
    const runtime = acquireTenantRuntime(tenantId) || {};
    const turn = claimNextTurn(entry.store, runtime);
    if (!turn) {
      if (runtime.runtimeId) releaseTenantRuntime(tenantId);
      continue;
    }

    entry.running = true;
    entry.lastStartedAt = Date.now();
    active += 1;
    // Deliberately not awaited: the pump keeps filling other slots.
    void executeTurn(tenantId, entry, turn);
  }
}

async function executeTurn(tenantId, entry, turn) {
  const generation = turn.runtime_generation ?? undefined;
  let timedOut = false;
  let timer = null;

  if (TURN_TIMEOUT_MS > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `[scheduler] turn ${turn.request_id} for ${tenantId} exceeded ${TURN_TIMEOUT_MS}ms — ` +
          'requesting cancellation; the lane stays held while the work may still run',
      );
    }, TURN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  try {
    if (typeof runTurn !== 'function') throw new Error('Scheduler has no runTurn handler');
    const outcome = await runTurn({ tenantId, turn, store: entry.store });

    // `null` means the delivery path already owns this turn's terminal state
    // (it committed a response and sent it). Completing it again here would be
    // rejected as stale and would log a false alarm.
    if (outcome === null) return;

    // The container may have been replaced while the model was working.
    if (generation !== undefined && !isCurrentGeneration(tenantId, generation)) {
      throw new StaleTurnResultError('Container generation changed during the turn', {
        tenantId, turnId: turn.id, generation,
      });
    }
    completeTurn(
      entry.store,
      turn.id,
      outcome || { state: TURN_STATE.COMPLETED },
      { requestId: turn.request_id, generation },
    );
  } catch (err) {
    const stale = err instanceof StaleTurnResultError || err?.code === 'STALE_TURN_RESULT';
    console.error(
      `[scheduler] turn ${turn.request_id} ${stale ? 'rejected as stale' : 'failed'} for ${tenantId}:`,
      err?.message || err,
    );
    // A stale result is discarded without touching the turn: the turn either
    // already reached a terminal state, or belongs to a generation that will be
    // re-executed from the original request.
    if (!stale) {
      try {
        completeTurn(
          entry.store,
          turn.id,
          { state: TURN_STATE.FAILED, errorCode: String(err?.code || 'TURN_FAILED') },
          { requestId: turn.request_id },
        );
      } catch (markErr) {
        console.error(`[scheduler] could not mark turn failed for ${tenantId}:`, markErr?.message || markErr);
      }
    }

    // Cancellation could not be proved, so terminate the gateway rather than
    // leave the lane held forever by work we cannot observe (§5).
    if (timedOut) {
      console.error(`[scheduler] terminating gateway for ${tenantId} after turn timeout`);
      await stopTenantGateway(tenantId).catch((stopErr) =>
        console.error(`[scheduler] gateway stop failed for ${tenantId}:`, stopErr?.message || stopErr),
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
    releaseTenantRuntime(tenantId);
    entry.running = false;
    active -= 1;
    if (hasWork(entry.store)) wake(tenantId);
    queueMicrotask(pump);
  }
}

/**
 * Restart recovery (§5). Returns turns left `running` by a crash to `queued`
 * and wakes any lane that has work.
 */
/**
 * Wake a lane from outside the scheduler.
 *
 * A provider status callback can terminalise a turn long after
 * `executeTurn`'s `finally` has already run and found the lane still busy.
 * Nothing else re-checks, so a message queued behind that turn waits for the
 * next inbound message — which may never come. Observed in production: a turn
 * settled by a Twilio `read` callback left the next message queued for
 * 11 minutes.
 */
export function wakeTenantLane(tenantId) {
  if (!lanes.has(tenantId)) return false;
  if (!hasWork(lanes.get(tenantId).store)) return false;
  wake(tenantId);
  return true;
}

export const STALE_SEND_MS = Number(process.env.ROCKY_STALE_SEND_MS || 10 * 60_000);

export function sweepStalledSends({ olderThanMs = STALE_SEND_MS, now = Date.now() } = {}) {
  let settled = 0;
  for (const [tenantId, entry] of lanes) {
    for (const turnId of staleSendStartedTurns(entry.store, olderThanMs, { now })) {
      if (!markOneSendStartedUnknown(entry.store, turnId, 'NO_PROVIDER_STATUS')) continue;
      settled += 1;
      console.warn(
        `[queue] ${tenantId}: turn ${turnId} sat in send_started for over ` +
          `${Math.round(olderThanMs / 60_000)}m with no provider status — marked ` +
          'delivery_unknown so the lane can move. The message may well have been delivered.',
      );
    }
    if (settled && hasWork(entry.store)) wake(tenantId);
  }
  return settled;
}

export function recoverTenantLane(tenantId, options = {}) {
  const entry = lane(tenantId);
  const recovered = recoverInterruptedTurns(entry.store, options);
  const unknown = markSendStartedUnknown(entry.store, 'CRASH');
  if (unknown) {
    console.warn(
      `[queue] ${tenantId}: ${unknown} turn(s) were mid-send at crash — marked delivery_unknown`,
    );
  }
  if (hasWork(entry.store)) wake(tenantId);
  return recovered;
}

export function schedulerStats() {
  const tenants = {};
  for (const [id, entry] of lanes) {
    tenants[id] = { running: entry.running, depth: queueDepth(entry.store) };
  }
  return { active, maxConcurrent, waiting: readyQueue.length, tenants };
}

/** Test seam: closes lane connections and clears in-memory state. */
export function resetScheduler() {
  for (const entry of lanes.values()) {
    try {
      entry.store.db.close();
    } catch {
      /* already closed */
    }
  }
  lanes.clear();
  readyQueue.length = 0;
  active = 0;
  draining = false;
  runTurn = null;
  maxConcurrent = Number(process.env.ROCKY_MAX_CONCURRENT_TENANTS || DEFAULT_MAX_CONCURRENT_TENANTS);
}
