export const MIN_RESIDENCY_MS = Number(process.env.ROCKY_MIN_RESIDENCY_MS || 60_000);
export const MIN_IDLE_MS = Number(process.env.ROCKY_MIN_IDLE_MS || 60_000);
export const ADMISSION_WAIT_MS = Number(process.env.ROCKY_ADMISSION_WAIT_MS || 45_000);
export const MIN_TYPICAL_GAP_MS = Number(process.env.ROCKY_MIN_TYPICAL_GAP_MS || 120_000);

export function overdueScore({ idleMs, typicalGapMs }) {
  const typical = Math.max(MIN_TYPICAL_GAP_MS, Number(typicalGapMs) || 0);
  return Math.max(0, Number(idleMs) || 0) / typical;
}

export function chooseVictim(entries, { now = Date.now(), requireOverdue = true } = {}) {
  const ranked = [];
  for (const e of entries || []) {
    if ((e.inFlight || 0) > 0) continue;
    if (now - (e.startedAt || 0) < MIN_RESIDENCY_MS) continue;
    const idleMs = now - (e.lastUserRequestAt || e.startedAt || 0);
    if (idleMs < MIN_IDLE_MS) continue;
    const score = overdueScore({ idleMs, typicalGapMs: e.typicalGapMs });
    // Overdue measures a person's rhythm. A cron-only container is serving no
    // one, so it yields whatever its score (invariant 5).
    if (requireOverdue && !e.cron && score < 1) continue;
    ranked.push({ tenantId: e.tenantId, score, cron: Boolean(e.cron) });
  }
  if (!ranked.length) return null;
  // People before jobs: a cron-only container is always the cheaper victim.
  ranked.sort((a, b) => (a.cron === b.cron ? b.score - a.score : a.cron ? -1 : 1));
  return ranked[0];
}

export async function admit(tenantId, deps) {
  const {
    hasWarm, warmCount, maxWarm, listEntries, stop,
    now = () => Date.now(),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    waitMs = ADMISSION_WAIT_MS,
    log = console,
  } = deps;

  if (hasWarm(tenantId)) return { admitted: true, reason: 'already-warm' };
  if (warmCount() < maxWarm()) return { admitted: true, reason: 'free-slot' };

  const take = async (victim, phase) => {
    await stop(victim.tenantId);
    log.log?.(
      `[admission] ${tenantId}: took the slot from ${victim.tenantId} ` +
      `(${victim.cron ? 'cron' : 'idle'}, overdue ${victim.score.toFixed(2)}, ${phase})`,
    );
    return { admitted: true, reason: phase, evicted: victim.tenantId };
  };

  const overdue = chooseVictim(listEntries(), { now: now() });
  if (overdue) return take(overdue, 'evicted-overdue');

  const deadline = now() + waitMs;
  while (now() < deadline) {
    await wait(Math.min(1000, Math.max(0, deadline - now())));
    if (hasWarm(tenantId)) return { admitted: true, reason: 'already-warm' };
    if (warmCount() < maxWarm()) return { admitted: true, reason: 'waited-for-slot' };
    const freed = chooseVictim(listEntries(), { now: now() });
    if (freed) return take(freed, 'evicted-after-wait');
  }

  const any = chooseVictim(listEntries(), { now: now(), requireOverdue: false });
  if (any) return take(any, 'evicted-least-bad');

  return { admitted: false, reason: 'all-busy-or-too-young' };
}
