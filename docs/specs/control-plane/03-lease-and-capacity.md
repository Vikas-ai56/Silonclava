# 03 — A lease owns the work; a container is capacity

**Status:** SPEC, not built. Grounded against `ea23eca`. Depends on **02**.
Not security-sensitive.

## Problem, restated after drift analysis

The system conflates *owning a unit of work* with *holding the machine that runs
it*. Both are acquired at `acquireTenantRuntime` (`tenant-gateway.mjs:256-265`)
and released together in `executeTurn`'s `finally` (`inbound-queue.mjs:246-253`).

The good news, found by tracing rather than assumed: **release is already mostly
correct.** A parked turn naturally drops `inFlight` to 0 and `active` by 1,
because the release is a `finally`. The work is in *deliberately* stopping the
container and in not letting a lease look like an active turn.

Three findings reshape the design:

1. **`inFlight` is not what it looks like.** It is a per-tenant counter of
   scheduler-claimed turns, effectively boolean (because `claimNextTurn` refuses
   while any non-queued non-terminal turn exists). It has **no timeout, no reaper
   and no ceiling**. If it leaks, the tenant becomes permanently un-evictable
   (`admission.mjs:14`), its idle timer re-arms forever (`tenant-gateway.mjs:311-313`),
   and shutdown never drains (`inbound-queue.mjs:70-76`).
2. **Cold-start turns are already unprotected.** `acquireTenantRuntime` returns
   `null` when the tenant has no pool entry (`:257-258`), and the entry is created
   later inside the turn with `inFlight: 0`. **For the whole of a tenant's first
   container-creating turn, `inFlight === 0`**, so invariant 1 does not protect
   it. After `MIN_RESIDENCY_MS` (60 s) it is a legal phase-3 victim while still
   running. Cold create is ~24 s and `TURN_TIMEOUT_MS` is 180 s — the window is real.
   **This is a pre-existing bug this slice should fix.**
3. **There is no mid-turn re-entry path at all.** `ensureTenantGateway` is called
   exactly once per turn (`tenant-openclaw.mjs:777`) and the SSE stream is held
   open for the whole turn (`:611-640`). Nothing re-checks or re-starts the
   container after that point. A parked-then-resumed run needs a path that does
   not exist today.

**And a latent bug found on the way, worth fixing here.** If a turn hits the
empty-reply branch (`router.mjs:483-486`) while its container is gone,
`isCurrentGeneration` fails, `StaleTurnResultError` is raised, and
`inbound-queue.mjs:222-236` deliberately does not touch the turn — so it stays
`claimed` **forever**, and `claimNextTurn` refuses every subsequent turn for that
tenant until the process restarts. There is no runtime stale-claim reaper.

## Design

**The lease lives on `turns`, not in a separate table.** `turns` already carries
`runtime_id` and `runtime_generation` (stamped at claim, `queue-store.mjs:157-166`)
and `attempt` — that *is* an owner identity, missing only an expiry. Adding a
second table would introduce a third identity for the same unit of work alongside
`request_id`.

> **This contradicts `DECISIONS.md:1874-1875`**, which approved "a lease table".
> The evidence it cites says the opposite — OpenMuse carries `leaseId`/`leaseUntil`
> *on the work row*: "no separate lock table… ownership is an attribute of the
> work". Columns-on-`turns` is the lower-drift option. **The spec must land a
> decision entry either way.**

New columns: `lease_owner`, `lease_until`, `parent_run_id`, `requested_by`
(logical parent, for audit), `spawned_by` (always main, for containment).

**Waiting does not hold capacity.** A `WAITING_*` turn holds its lease and is
**not** `inFlight`. It is therefore a legal eviction candidate, which is the whole
point of rule 1. `admission.mjs:14` needs no change — the accounting does.

**Container release must route through `stopTenantGateway`** (`tenant-gateway.mjs:679-698`),
never `dockerStopContainer` directly. That function calls `unsuperviseTenant`
(`:680`), deletes the pool entry (`:689` — which is what actually frees the slot)
and clears the Composio runtime (`:697`). `DECISIONS.md:1784-1787` warns that any
eviction path bypassing it "will fight admission for memory".

**Fix the cron-slot leak.** `cronWarm` (`wake-scheduler.mjs:20`) is accounting
separate from the pool, capped at 3 against the pool's 5. A parked cron run would
hold a cron slot with **no container** until the overrun budget expires — exactly
the coupling this slice breaks, relocated one layer up. `cronWarm` release must be
part of it.

**Lease TTL and the steal rule (D3).** Open for the user. Constraints: it must
interact with `busy_timeout = 250` (`test/tenant-data-store.test.mjs:31-45`), so
the spec needs an explicit `SQLITE_BUSY` retry story; and `turns.updated_at` is
ISO-8601 text (`queue-store.mjs:23-25`) while `cron_schedule_mirror.next_run_at_ms`
is epoch-ms (`migrations.mjs:214`) — the repo is inconsistent and the lease column
should pick one deliberately.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/migrations.mjs` (new migration) | Lease columns on `turns` | Medium — additive, no rebuild if 02's 006 already rebuilt |
| `src/tenant-data/queue-store.mjs:155-166` | Stamp lease owner + expiry at claim | Medium |
| new `src/tenant-data/lease-store.mjs` | Renew, expire, steal. **Must** live under `src/tenant-data/` | Medium |
| `src/openclaw/tenant-gateway.mjs:256-265` | Fix the cold-start `inFlight === 0` gap | **High** — pre-existing bug |
| `src/openclaw/tenant-gateway.mjs:641-667` | Newly created entries never arm an idle timer; `lastUserRequestAt` is 0 | Medium |
| `src/inbound-queue.mjs:246-253` | On park: release runtime, then stop the container deliberately | **High** |
| `src/wake-scheduler.mjs:20,60-62,182` | `cronWarm` release on park | **High** |
| `src/openclaw/tenant-openclaw.mjs:777` | Re-entry: re-acquire a container on resume | **High** — no such path exists |
| `src/inbound-queue.mjs:222-236` | Stale-claim reaper for the wedge case | Medium — latent bug fix |
| `src/config.mjs` | `ROCKY_LEASE_TTL_MS` — must be exported (`test/no-undefined-identifiers.test.mjs:82-106`) | Low |

## Invariants preserved

- **Invariant 1 changes meaning deliberately.** "Never evict work in flight"
  becomes "never evict work that is *executing*". A waiting run holds a lease, not
  a slot. `docs/features/10:31-33` must be restated, and this is the single most
  important doc consequence of the change.
- One owner for stop-for-capacity — preserved only if release routes through
  `stopTenantGateway`.
- The generation fence — a resumed run carries a *stale* generation by definition,
  so `queue-store.mjs:221-229` needs an explicit ruling.

## Tests

**New.**
- Five waiting tenants still admit a sixth.
- A parked turn's container is stopped and its pool entry removed.
- A parked cron run releases its cron slot.
- A cold-start turn is not evictable mid-create (the pre-existing gap).
- An expired lease is stealable; a live one is not.
- The wedge case: a stale-claimed turn is reaped without a process restart.

**Must not break.** `test/admission.test.mjs:28-35`,
`test/gateway-supervision.test.mjs:45-46,153-159`.

## Docs in the same PR

- `docs/features/10-admission-and-eviction.md:31-33` — invariant 1 restated;
  also fix the stale "Status: spec" banner at `:3`.
- `docs/features/07-scheduling-and-hibernation.md:14-16` — "a `WAITING_*` turn is
  not `inFlight`"; fix the stale `yieldSlotForInteractive()` reference at `:35`;
  resolve the 2-vs-3 cron slot contradiction.
- `docs/CODEBASE.md` — new `lease-store.mjs` row.
- `DECISIONS.md` — *A lease owns the work; a container is capacity* (recording the
  columns-vs-table reversal against `:1874-1875`), plus D3.
- `docs/backlog.md` — BL-016 materially advanced; new item for multi-host leases
  (`DECISIONS.md:1923`).

## Done criteria

- A run waiting on a human holds no container and no slot.
- A cold-start turn cannot be evicted mid-create.
- A parked cron run frees its cron slot.
- A resumed run re-acquires a container through a real path.
- No wedged lane survives a stale claim.
