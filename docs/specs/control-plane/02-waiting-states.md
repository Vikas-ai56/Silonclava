# 02 — Three waiting states, and the lane deadlock

**Status:** SPEC, not built. Grounded against `ea23eca`. Depends on **01**.
Not security-sensitive. Contains a table-rebuild migration.

## Problem, restated after drift analysis

Adding three states looks like an enum edit. It is not. The turn ledger encodes
"is something happening?" as **"the state is not `queued` and not terminal"**, in
at least four places. Three new non-terminal, non-queued states silently change
the meaning of all of them.

**The crux — the lane deadlock.** `claimNextTurn`'s exclusivity probe is
`SELECT id FROM turns WHERE state NOT IN ('queued', <terminals>) LIMIT 1`
(`queue-store.mjs:142-147`). A run parked on a human approval matches, so
**every subsequent turn for that tenant is refused, indefinitely.** `TURN_TIMEOUT_MS`
(`inbound-queue.mjs:42`) cannot rescue it: that timer only lives for the duration
of `executeTurn`'s `await` at `:197`, and a parked turn has already returned
through the `finally` at `:246-253`.

**And the user is not told.** Coalescing joins only `queued` turns
(`queue-store.mjs:87-94`, comment: *"never join a running one"*). A message
arriving during an approval wait creates a **second** `queued` turn that then
cannot be claimed. The busy-ack was deliberately removed (`router.mjs:533-539`),
so messages pile up in silence.

Five more binary assumptions break:

| Where | Assumption | Breaks as |
|---|---|---|
| `queue-store.mjs:278-286` | `queueDepth`/`hasWork` = "not terminal" | A parked turn makes `hasWork()` permanently true → `wake()` → `claimNextTurn` returns null → `continue`. Deduped at `:147-148` so not a hot spin, but `schedulerStats().depth` reports permanent phantom backlog |
| `context-store.mjs:39-46` | "the last settled turn" is the newest terminal row | A parked turn is invisible, so transcript-replay skips the most recent real work |
| `queue-store.mjs:257,272`; `:389` | Recovery matches only `claimed` / `send_started` | A crash while `waiting_subrun` or `retry_wait` strands the turn in a state **no recovery path touches** |
| `inbound-queue.mjs:93-104` | Shutdown classification covers `claimed` + `send_started` | Three new states invisible at shutdown; `index.mjs:701-706` under-reports |
| `queue-store.mjs:211-215`; `delivery-store.mjs:43-47` | Only TERMINAL blocks a write | A stale container result arriving for a turn now in `retry_wait` is **accepted** and overwrites it |

## Design

**Three states, each named after the event that ends the wait** (rule 9):
`WAITING_SUBRUN`, `AWAITING_APPROVAL`, `RETRY_WAIT`. A single `blocked` state is
rejected: the three have different timeouts, different escalation and different
meanings to an auditor.

**Make the two classifications real.** `PRE_COMMIT_STATES` and
`POST_COMMIT_STATES` (`migrations.mjs:17,21-24`) are exported with **zero call
sites**. They are the correct home for the re-execute-vs-resend distinction that
is currently three hardcoded literals in three files. This slice wires them up
and adds the waiting states to the right one — `WAITING_*` are pre-commit, so a
crash re-executes rather than resends.

**Fix the lane, not the probe.** `claimNextTurn`'s exclusivity must mean *"a
turn is executing right now"*, which is what it always meant. `WAITING_*` is not
executing. So the probe excludes waiting states as well as `queued` and terminals.
A resumed run re-enters through the normal claim path.

**Coalescing (D2).** Recommended: a message arriving during `AWAITING_APPROVAL`
**coalesces into a new queued turn and the user is told** what it is waiting on.
Silence is the failure mode the analysis found; a parked run plus an unacked queue
is exactly the "work waiting indefinitely on nobody" that rule 9 exists to prevent.

**`completeTurn` and `saveResponse` must reject waiting states**, not just
terminal ones — a late result must not overwrite a parked turn.

## Migration (D4)

SQLite cannot `ALTER` a CHECK, and the current list lives inside `MIGRATION_002`
(`migrations.mjs:154-157`). Shipped migrations are checksum-frozen (`:294-302`),
so **append migration 006**; never edit 002.

It must repeat the full rebuild of `:150-193`: `CREATE TABLE turns_new` with the
ten-member CHECK, `INSERT … SELECT` preserving `id`, `DROP TABLE turns`, `RENAME`,
and **recreate both indexes** (`ix_turns_state`, `ix_turns_conversation`, `:191-192`)
— `DROP TABLE` takes them with it. Reproduce
`turns.response_message_id REFERENCES messages(id)` (`:166`).

`migrateTenantDb` toggles `PRAGMA foreign_keys = OFF` outside the transaction
(`:306-330`) precisely because 002's rebuild once cascade-deleted every
`turn_messages` row. That is the reason, and it must be recorded.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/migrations.mjs:5-13` | Three new `TURN_STATE` members | Low |
| `src/tenant-data/migrations.mjs` (new 006) | Table rebuild, ten-member CHECK, both indexes, FK reproduced | **High** |
| `src/tenant-data/migrations.mjs:17,21-24` | Wire up the dead constants; classify the new states | Medium |
| `src/tenant-data/queue-store.mjs:142-147` | Exclusivity probe excludes `WAITING_*` | **High** — the crux |
| `src/tenant-data/queue-store.mjs:87-94` | Coalescing (D2) | **High** |
| `src/tenant-data/queue-store.mjs:211-215` | Reject waiting states, not just terminal | Medium |
| `src/tenant-data/queue-store.mjs:278-286` | `queueDepth` excludes waiting; add a waiting count | Medium |
| `src/tenant-data/delivery-store.mjs:43-47` | Same rejection | Medium |
| `src/tenant-data/context-store.mjs:39-46` | "last settled turn" must see parked turns | Medium |
| `src/inbound-queue.mjs:93-104` | Shutdown classification learns the new states | Medium |
| `src/inbound-queue.mjs:199-202` | A third outcome meaning "parked — release, do not complete" | **High** — no such outcome exists today |
| `src/tenant-cli/resources/turn.mjs:38` | Default filter `failed,delivery_unknown` gains `awaiting_approval` | Low |
| `src/tenant-cli/resources/state.mjs:59` | Operator summary under-reports without a waiting count | Low |
| `scripts/gate3-local.mjs:193-200` | Hardcoded terminal list + 20s poll — a parked turn makes this **hang, not fail** | Medium |

## Invariants preserved

- One active turn per tenant — preserved in meaning; the probe is corrected to
  match that meaning rather than widened.
- The immutable envelope (`queue-store.mjs:107-116`) — untouched.
- Never re-invoke the model on a committed turn — `WAITING_*` are pre-commit, so
  this is unaffected; the classification is now explicit rather than implied.
- Append-only migrations — 002 is not edited.

## Tests

**New.**
- A turn in each `WAITING_*` state does not block a subsequent claim.
- A message arriving during `AWAITING_APPROVAL` behaves per D2, and the user is told.
- A late `completeTurn` / `saveResponse` against a parked turn is rejected.
- Migration 006 preserves every `turn_messages` row (the 002 incident).
- The new CHECK still rejects `'running'` and `'not_a_state'`
  (`test/tenant-data-store.test.mjs:400-405` must keep passing).
- A crash in each waiting state is recovered by *some* path.

**Coverage gaps this slice must close** — nothing today enumerates `TURN_STATE`
or asserts exhaustiveness, and nothing pins a schema version or migration count.
Add both; otherwise a state omitted from a classification is invisible.

**Must not break.** `test/message-coalescing.test.mjs:26`,
`test/end-to-end-flow.test.mjs:98`, `test/tenant-data-store.test.mjs:401-405`.

## Docs in the same PR

- `docs/features/01-inbound-turn.md:49-59` — the branched machine; which states
  re-execute and which resend.
- `docs/features/03-persistence-and-context.md:10-16` — migration table gains 006.
- `docs/CODEBASE.md:196-198` — schema version and table list.
- `DECISIONS.md` — two entries: *Three waiting states, each named after the event
  that ends the wait* (with the single-`blocked` rejection) and the D2 coalescing
  ruling. Plus D4's migration strategy, recording the 002 cascade incident.

## Done criteria

- A tenant with a parked turn still accepts and serves new messages.
- No message is silently queued behind an approval.
- Every `WAITING_*` state has a recovery path at boot and at shutdown.
- `PRE_COMMIT_STATES`/`POST_COMMIT_STATES` have call sites and a test.
- Migration 006 preserves `turn_messages`; suite green.
