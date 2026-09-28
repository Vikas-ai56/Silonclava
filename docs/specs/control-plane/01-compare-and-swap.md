# 01 — Compare-and-swap on every turn transition

**Status:** SPEC, not built. Grounded against `ea23eca`. Not security-sensitive.
Ships alone; everything after it depends on it.

## Problem, restated after drift analysis

There is no compare-and-swap anywhere in the turn ledger. Single-active-turn is a
read-then-write inside one transaction (`queue-store.mjs:141-147`), and every
other transition is a blind `UPDATE turns SET state = ? WHERE id = ?`.

That is safe *today* only because `better-sqlite3` is synchronous and Rocky is one
process. It stops being safe the moment a turn can be parked and resumed, because
two actors can then legitimately reach the same row: the resuming worker and the
sweep. Slices 02–04 all introduce that, so this has to land first.

Three findings change the naive plan:

1. **`beginSend` (`delivery-store.mjs:94-95`) has no guard at all** — no SELECT,
   no state check, no generation check. And the `delivery_attempts` INSERT at
   `:90-93` happens *first*, computing `attempt` with `MAX()+1` at `:87-89`. If
   the turn UPDATE then matches zero rows, an orphan `status='sending'` row is
   already committed. This is the most dangerous conversion in the file.
2. **`applyProviderStatus` (`delivery-store.mjs:207-215`) must NOT get a
   prior-state guard.** It is *designed* to overwrite a terminal state — a late
   provider callback moving `delivery_unknown → completed` is the correction path
   (comment `:204-206`). Its monotonicity gate at `:193-197` ranks against
   `delivery_attempts.status`, not `turns.state`. A naive CAS here breaks
   delivery correction.
3. **Callers expect a throw, not a return.** `completeTurn`'s generation check
   raises `StaleTurnResultError` (`queue-store.mjs:186-193`), caught at
   `inbound-queue.mjs:216-217`. If a zero-row CAS silently returns instead, the
   `stale` branch stops firing and `:225-236` double-marks.

## Design

**Every transition names the state it was planned against.** A transition becomes
`UPDATE turns SET state = ? … WHERE id = ? AND state IN (<expected>)`, and a
zero-row result is a *signal*, not an error to swallow.

**The zero-row contract (D1).** Keep the existing throw shape rather than
inventing a second one: a lost CAS raises `StaleTurnResultError`, which already
has a caught, tested handler. The alternative — returning `{changed:false}` —
would need every call site audited to stop treating a falsy return as success.

**`applyProviderStatus` is explicitly exempt**, and the spec says so in a comment
beside it so a future reader does not "fix" it.

**Ordering fix in `beginSend`.** Move the turn CAS *before* the `delivery_attempts`
INSERT. If the CAS loses, no attempt row is written. This also makes the
`MAX()+1` read-then-insert race narrower, though it does not close it — see 03.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/queue-store.mjs:155-166` | `claimNextTurn` — add `AND state='queued'`. Sole caller already handles `null` (`inbound-queue.mjs:166-169`) | **Low** |
| `src/tenant-data/queue-store.mjs:231-233` | `completeTurn` — CAS on caller-supplied expected states; zero rows → `StaleTurnResultError` | **High** — see D1 |
| `src/tenant-data/delivery-store.mjs:72-74` | `saveResponse` — CAS on `claimed`. Must abort before `beginSend` at `router.mjs:257` | **High** — a zero-row here with the outbound `messages` row already committed (`:60-70`) leaves an orphan |
| `src/tenant-data/delivery-store.mjs:83-95` | `beginSend` — CAS on `response_saved`, **reordered before** the attempts INSERT | **High** — three callers: `router.mjs:257`, `:285`, `cron-ingress.mjs:59`. `:285` genuinely races `:257` |
| `src/tenant-data/delivery-store.mjs:133-135` | `recordSendResult` — CAS on `send_started`; zero rows means a provider callback already terminalised it | Medium |
| `src/tenant-data/delivery-store.mjs:155-156` | `markDeliveryUnknown` — CAS on `send_started` | Medium |
| `src/tenant-data/delivery-store.mjs:207-215` | `applyProviderStatus` — **NO CHANGE**, plus a comment recording why | Low |
| `src/tenant-data/queue-store.mjs:253-274` | Already CAS-shaped (`WHERE state='claimed'`). Fix the return value: the writes-enabled branch returns `0` at `:266` despite mutating rows, and `router.mjs:575` sums it | Medium |
| `src/inbound-queue.mjs:210,227` | Handle the new zero-row throws | Medium |
| `src/router.mjs:256,257,285` | Abort the send path on a lost CAS | **High** |
| `src/cron-ingress.mjs:59` | Same | Medium |

No new files.

## Invariants preserved

- Persist before send — strengthened, since `beginSend` can no longer start a send
  for a turn whose bytes were not committed.
- Never re-invoke the model on a committed turn — untouched; the three literals at
  `queue-store.mjs:257,272,389` and `delivery-store.mjs:228` stay.
- The generation fence (`queue-store.mjs:221-229`) is **additional to** the CAS,
  not replaced by it.
- No async inside a transaction — no new transactions introduced.

## Tests

**Update (~20 mechanical edits, D1).** Bare `completeTurn(store, id, {state})`
calls at `test/tenant-scheduler.test.mjs:90,140,166,191,213,259`,
`test/context-assembly.test.mjs:31`, `test/end-to-end-flow.test.mjs:258`,
`test/isolation-two-tenants.test.mjs:133`, and production `src/router.mjs:486`.

**New.**
- A CAS that loses raises `StaleTurnResultError` and the caller does not double-mark.
- `beginSend` losing its CAS writes **no** `delivery_attempts` row.
- `applyProviderStatus` still moves `delivery_unknown → completed` (the correction
  path must not regress).
- `resendCommittedResponses` and `deliverResponse` racing the same
  `response_saved` turn produce exactly one send.

**Must not break.** `test/turn-correlation.test.mjs:66,88,103` require a throw.
`test/gateway-supervision.test.mjs:181-202` — no `.prepare(` outside `src/tenant-data/`.

## Docs in the same PR

- `docs/features/01-inbound-turn.md:49-51` — state machine gains CAS notation; one
  sentence that a zero-row update means re-read.
- `docs/CODEBASE.md:60-61` — correct "`queue-store.mjs` … the only place SQL is
  written" (false: nine files) and note the CAS contract.
- `DECISIONS.md` — new entry: *Compare-and-swap replaces blind state writes, and a
  zero-row update is a signal, not an error.* Must record the throw-vs-return
  choice and why `applyProviderStatus` is exempt.

## Done criteria

- Every `UPDATE turns SET state` in `src/tenant-data/` names its expected prior
  state, except `applyProviderStatus`, which carries a comment saying why.
- A lost CAS raises `StaleTurnResultError` and no caller treats it as success.
- `beginSend` writes no attempt row when its CAS loses.
- `recoverInterruptedTurns` returns the true mutated-row count in both branches.
- Suite green.
