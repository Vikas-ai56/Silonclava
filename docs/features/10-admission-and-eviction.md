# 10 — Admission, eviction and the scheduler

**Status: implemented.** `src/openclaw/admission.mjs` is the policy and
`src/tenant-data/rhythm.mjs` supplies the per-tenant rhythm.

*Corrected 2026-09-24: this banner read "spec, 2026-09-21 — implementation follows
this document" long after the code shipped.* Invariants 1, 2, 3 and cron-yield are
enforced in code. Two are weaker than written: invariant 4 ("one owner") is not
literally true — admission, the idle timer and `preemptOverruns` all stop containers,
though all three funnel through `stopTenantGateway`; and invariant 5's "cron never
takes an interactive slot" rests on a pre-check in `wake-scheduler.mjs` that can race
`admitTenant`, because `admit()` has no notion of who called it.

## Problem

`MAX_TENANTS_PER_HOST` is a wall. At capacity a new tenant is refused — at
*provisioning*, so a person's first message fails. Meanwhile a container that
has been quiet for an hour keeps its slot until the 20-minute idle timer
happens to fire, and three separate mechanisms each decide a container's fate
with no precedence between them.

## What the data says

Measured from production, 222 inbound messages over 28.3 h:

| | |
|---|---|
| p50 / p75 / p90 inbound gap | 54 s / 137 s / 402 s |
| arrivals within 20 min of the previous | 94.6% |
| median conversation | 25.2 min |
| duty cycle, heavy user | 37% |
| warm start vs cold create | 2.3 s vs 24 s |

**Recency predicts return, not staleness.** Plain LRU would evict the tenant
most likely to speak next, which is why the policy below scores a container
against *that tenant's own rhythm* instead of against the clock.

## Invariants

1. **Never evict work in flight.** `inFlight > 0` is untouchable. Kubernetes
   node-pressure eviction ignores this; it is a last-resort OOM defence, not a
   scheduler, and not a model to copy.
2. **Never evict a container younger than `MIN_RESIDENCY_MS`.** This also bounds
   the eviction rate, which is what prevents thrash — no separate cooldown.
3. **Registration is not a warm slot.** Provisioning never consults the
   ceiling. A tenant may exist while cold.
4. **One owner.** Admission decides every stop-for-capacity. The idle timer is
   an input, not a second actor.
5. **Cron yields to people.** Interactive work may take a cron slot. Cron never
   takes an interactive one.

## Signals (all already tracked)

| Signal | Source |
|---|---|
| busy | `entry.inFlight` |
| residency | `entry.startedAt` |
| idle | `entry.lastUserRequestAt` |
| cron-band | `cronWarm` in the wake scheduler, injected as a predicate |
| rhythm | p75 inbound gap from the tenant's own transcript |

## The decision

`admit(tenantId)` when the tenant has no warm container:

```
slot free                        → admit
otherwise choose a victim:
  candidates = entries where inFlight == 0
                          and age    > MIN_RESIDENCY_MS
                          and idle   > MIN_IDLE_MS
  order      = cron-band first, then highest overdue score
  overdue    = idle / p75_gap(tenant)

  phase 1  cron-band victim, or overdue >= 1 → stop it, admit
  phase 2  wait up to ADMISSION_WAIT_MS for a slot or a candidate
  phase 3  victim with the highest overdue → stop it, admit
  phase 4  nothing evictable                → refuse, honestly
```

`overdue` measures a person's rhythm, so it does not gate a cron-band victim:
a cron container is serving no one and yields whatever its score.

Phase 2 is the queue. It is bounded and per-arrival, not a data structure: a
turn takes ~25 s, so when every container is busy a short wait is usually
enough. Phase 3 exists because a real user waiting now outranks an incumbent
who might return later. Phase 4 means every slot is busy or too young — genuine
capacity exhaustion, and the user is told plainly.

## Knobs

| Name | Default | Meaning |
|---|---|---|
| `ROCKY_MIN_RESIDENCY_MS` | 60 000 | a new container is safe this long |
| `ROCKY_MIN_IDLE_MS` | 60 000 | quiet this long before it is a candidate |
| `ROCKY_ADMISSION_WAIT_MS` | 45 000 | phase-2 bound |
| `ROCKY_MIN_TYPICAL_GAP_MS` | 120 000 | rhythm floor, and the default when a tenant has too little history |

## What this removes

- `yieldSlotForInteractive()` and its call in the router — admission owns cron
  eviction now (invariant 4).
- `assertHostCapacity()` from `provision.mjs` (invariant 3). Its comment cites
  the always-on runtime, a premise reversed when hibernation landed on
  2026-09-18.
- Two guards in `gateway-supervision.test.mjs` change deliberately: the ceiling
  is no longer enforced at provisioning, and it no longer refuses rather than
  evicting. Both are replaced by tests for the policy above.

## Non-goals

Snapshot/suspend instead of keep-alive (needs CRIU or a microVM), cross-host
scheduling, and any change to the isolation boundary. Past ~5 concurrent
conversations the answer is RAM, not policy.

## Test plan

Unit: scoring order, every invariant, each of the four phases.
Live: fill to `MAX_TENANTS_PER_HOST`, then admit one more and assert a victim
was evicted rather than a refusal; assert a busy container is never chosen.
