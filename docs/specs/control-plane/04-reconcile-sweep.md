# 04 — The reconcile sweep becomes periodic

**Status:** SPEC, not built. Grounded against `ea23eca`.
**Depends on 03 and must not ship before it.** Not security-sensitive.

## Problem, restated after drift analysis

Recovery runs once, at boot (`index.mjs:173`), before the channel accepts traffic.
A turn that wedges *while the process stays up* is never recovered. Rule 2 says a
committed outcome needs a sweeper; today it has one only at startup.

**But running today's recovery on a timer would be actively destructive.** This is
the finding that reorders the whole suite:

1. **`recoverInterruptedTurns` has no owner and no age predicate.**
   `queue-store.mjs:271-274` rewrites *every* row in `claimed`, unconditionally.
   On a timer, a turn claimed two seconds ago and legitimately executing inside
   the container is yanked to `queued`, re-claimed by `pump()`, and **the model is
   re-invoked while the first call is still running.** This is precisely why the
   sweep is boot-only: at boot, by construction, nothing is running.
2. **The writes-enabled branch is terminal.** `:253-259` turns every `claimed` row
   into `failed`/`UNCERTAIN_WRITE`. Run periodically with write tools on,
   **no turn could ever complete.**
3. **`markSendStartedUnknown` has no age check.** `:386-391` marks every
   `send_started` row `delivery_unknown`. The window between `beginSend` and
   `recordSendResult` is exactly the provider HTTP call. A sweep would permanently
   reclassify healthy in-flight sends as ambiguous and stamp `error_code='CRASH'`.
   `applyProviderStatus` can correct it later, so the damage is operator noise
   rather than lost messages — but it destroys the signal the state exists to carry.
4. **`resendCommittedResponses` is the one that is already sweep-shaped, and the
   one that is unsafe to repeat.** `router.mjs:280-301` is correct rule-2 design:
   unconditional replay, no `notified` flag. But `channel.sendText` is not
   provider-idempotent, so a periodic run re-delivers the same message every
   interval for any turn stuck at `response_saved`.

**Therefore: lease expiry (03) is the precondition.** A periodic sweep is only
safe once "this turn's owner is dead" is a fact in the database rather than an
assumption about process lifetime.

## Design

**The sweep acts on expired leases, not on states.** Every destructive action
gains the predicate *"and its lease has expired"*. Boot recovery keeps its current
unconditional form, because at boot the assumption holds and is worth keeping.

**Resend stays unconditional but becomes rate-limited per turn.** Rule 2 is right
that a `notified` flag is wrong — it is one more write lost in the same crash. The
fix for non-idempotent `sendText` is not a flag but a floor: a turn's bytes are not
re-sent more often than once per interval N, tracked by `delivery_attempts` which
already exists and already has a `MAX()+1` attempt counter.

**Four hard constraints, each from a test:**

| Constraint | Why | Enforced by |
|---|---|---|
| Must not create databases | A sweep that opens every tenant's store brings empty ledgers into existence | `test/router-inbound.test.mjs:76-87`; the existing skip at `router.mjs:573` |
| Must `.unref()` | An un-unref'd interval blocks SIGTERM exit | `test/boot-smoke.test.mjs:51-53` |
| Must not swallow its own errors | The `markSendStartedUnknown` precedent | `test/no-undefined-identifiers.test.mjs:10-11` |
| Must respect `draining` | `pump()` bails when draining (`inbound-queue.mjs:155`) but `recoverTenantLane`'s `wake()` at `:269` does not check | — |

**Follow the existing precedent exactly.** Two unref'd interval loops already
exist and are both stopped at `index.mjs:685-686`: `startWakeScheduler`
(`wake-scheduler.mjs:229-240`) and `startGatewaySupervisor`
(`tenant-gateway.mjs:815-828`). Adopt that start/stop/unref shape.

**Fix the wrong metric.** `recoverInterruptedTurns` returns `0` in the
writes-enabled branch (`:266`) while having mutated rows; `router.mjs:575` sums it
and `:580` logs it. A periodic sweep whose counter is wrong is worse than no sweep.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/queue-store.mjs:244-276` | Lease-expiry predicate on both branches; fix the return count | **High** |
| `src/tenant-data/queue-store.mjs:386-391` | Age/lease predicate | **High** |
| `src/router.mjs:280-301` | Per-turn resend floor | **High** — non-idempotent send |
| new sweep module | Interval, unref, stop at shutdown, per-tenant error isolation | Medium |
| `src/index.mjs:173, 685-686` | Start/stop wiring beside the existing two loops | Medium |
| `src/inbound-queue.mjs:269` | Respect `draining` | Low |
| `src/config.mjs` | `ROCKY_RECONCILE_INTERVAL_MS`, exported | Low |

## Invariants preserved

- Boot ordering — reconcile before the channel accepts traffic
  (`test/wiring-regressions.test.mjs:16-20`) is untouched; the periodic sweep is a
  *second, continuous* actor, not a replacement.
- Never re-invoke the model on a committed turn — strengthened: the sweep must
  carry the same `claimed`-only predicate the boot path has.
- Rule 2's "no `notified` flag" — preserved. The resend floor is a rate limit, not
  a completion marker.

## Tests

**New.**
- A live claimed turn with an unexpired lease is **not** touched by the sweep.
- An expired lease is recovered.
- With `writesEnabled: true`, a live turn is not marked `UNCERTAIN_WRITE`.
- A healthy in-flight send is not reclassified `delivery_unknown`.
- A stuck `response_saved` turn is re-sent at most once per interval.
- The sweep does not create a database for a tenant with no store.
- SIGTERM exits cleanly with the sweep running.

**Coverage gap this slice must close.** The `writesEnabled: true` recovery branch
(`queue-store.mjs:252-267`) is **completely untested today** — no test passes
`writesEnabled`. That is the branch this slice makes most dangerous.

## Docs in the same PR

- `docs/features/01-inbound-turn.md:53-59` — `resendCommittedResponses()` runs "at
  boot **and on every sweep**"; the sweep is a second continuous actor; it must not
  create databases.
- `docs/features/08-deploy-and-operations.md:79-91` — the new interval setting.
- `DECISIONS.md` — *The reconcile sweep is periodic and unconditional.* This
  **supersedes `DECISIONS.md:1753-1759`** ("Committed replies are re-sent at boot").
  Record the four constraints and why lease expiry is the precondition.

## Done criteria

- A turn wedged while the process is up is recovered without a restart.
- No live turn is ever yanked back by the sweep, with write tools on or off.
- A stuck committed reply is re-sent, bounded.
- SIGTERM still exits within the shutdown budget.
- The recovery counter is accurate in both branches.
