# Control-plane spec suite — phases 1–3

**Status:** SPEC. Nothing here is built. Grounded against the working tree at
`ea23eca` (2026-09-24), suite green at 501 pass / 0 fail.

Build-time artifacts. Per `docs/README.md` the durable reference is
`features/` + `DECISIONS.md` + `CODEBASE.md`; each slice lands its docs updates
in the same PR, and these files are deleted once it has.

## Sizing

**Large.** Six slices, ~30 existing files changed, 2–3 net-new modules, one
table-rebuild migration over every tenant database, one security-boundary touch
(the step gate). No new dependencies.

| Spec | Slice | Risk |
|---|---|---|
| `01-compare-and-swap.md` | Blind state writes → CAS; zero-row contract | **High** — 11 transition sites, ~20 test edits |
| `02-waiting-states.md` | Three `WAITING_*` states; the lane-deadlock fix | **High** — table rebuild; `claimNextTurn` is the crux |
| `03-lease-and-capacity.md` | Lease ownership; a waiting run hands back its container | Medium |
| `04-reconcile-sweep.md` | Boot-only recovery → periodic | **High** — destructive if it lands before 03 |
| `05-step-ledger.md` | `run_steps`, declare/complete, `status` | Medium |
| `06-step-verification.md` | Host-side verification of a completion claim | **High** — security boundary |
| `90-retroactive-decisions.md` | Four invariants that exist only in code + tests | Medium — no code change |

## Sequencing

```
01 ──> 02 ──> 03 ──> 04          (strict; 04 before 03 is destructive)
              └────> 05 ──> 06
90 ─────────────────────────────  independent, do it first
```

**04 must not ship before 03.** `recoverInterruptedTurns` rewrites *every*
`claimed` row with no owner and no age predicate (`queue-store.mjs:271-274`).
On a timer, without lease expiry, it yanks back turns that are legitimately
executing and re-invokes the model while the first call is still in flight.
With write tools enabled it is worse: every `claimed` row becomes
`failed`/`UNCERTAIN_WRITE`, so no turn could ever complete.

**90 first.** It writes down four load-bearing invariants that today exist only
in code comments and tests. Doing it first means the later slices can cite them.

## Principles these must not weaken

From `docs/PATTERNS-durable-work.md`:

- **Rule 1** — waiting work must not hold expensive things. The whole of 03.
- **Rule 2** — a committed outcome needs a sweeper, and no `notified` flag. 04.
- **Rule 3** — approve content, not a row. 06.
- **Rule 4** — let the storage engine enforce uniqueness. 03's lease key.
- **Rule 5** — a transition must assert the state it was planned against. 01.
- **Rule 9** — name a waiting state after what ends the wait. 02.

From `docs/PATTERNS.md`: **P1** (state has an owner and a destroyer), **P2**
(commit intent before an irreversible act), **P3** (classify failures by what may
already have happened), **P5** (recently used is not currently in use).

## Invariants carried into every spec

1. **Persist before send.** Bytes committed (`delivery-store.mjs:56-74`) before
   any provider call; ordering enforced by statement order at `router.mjs:256-257`.
   Not schema-enforced — only call ordering.
2. **Never re-invoke the model on a committed turn.** Three hardcoded literals:
   `queue-store.mjs:257,272` (recovery matches only `claimed`),
   `delivery-store.mjs:228` (`turnsAwaitingSend` selects only `response_saved`),
   `queue-store.mjs:389`. Plus the code-shape assertion at
   `test/wiring-regressions.test.mjs:22-26`.
3. **One active turn per tenant.** `queue-store.mjs:142-147`.
4. **No network / model / Docker / encryption call inside a transaction.**
   Stated `queue-store.mjs:18-21`, rationale `DECISIONS.md:40`. **No test asserts
   it** — the two existing tests check `.prepare()` placement, not async in a
   transaction.
5. **The turn envelope is immutable.** Recipient frozen at enqueue
   (`queue-store.mjs:107-116`), runtime id/generation stamped at claim
   (`:157-166`), validated at completion (`:221-229`).
6. **SQL stays in `src/tenant-data/`.** `test/gateway-supervision.test.mjs:181-202`
   scans raw file text — a comment containing `.prepare(` trips it.
7. **`src/**` outside `src/tenant-cli/` may not reference `tenant-cli/resources/`.**
   `test/tenant-control-plane-boundary.test.mjs:31-44`, also raw-text.

## Corrections this analysis surfaced

Fix these while in the neighbourhood; each is pre-existing drift, not caused by
this work.

| Where | Problem |
|---|---|
| `docs/README.md:27-32` | Claims deleted phase-spec sections "resolve through DECISIONS.md". **Materially false for §2, §1.5, §7's class list and §5's envelope.** See `90-retroactive-decisions.md` |
| `DECISIONS.md:1090-1093` | Claims the deleted specs are recoverable from git or the prod host. **Neither is true** — `SPEC-phase3c*` was never committed, and `docs/` is not in `deploy/rsync-exclude.txt` so `--delete-after` removed the prod copies |
| `docs/features/03:26` | "`queue-store.mjs` the only place raw SQL is written" — nine files under `src/tenant-data/` call `.prepare()`. The boundary is the directory |
| `docs/features/03:30,39-48` | Documents `search-store.mjs`, deleted 2026-09-22 |
| `docs/features/10:3` | "Status: spec … Implementation follows this document" — it is implemented |
| `docs/features/07:33` vs `DECISIONS.md:42` vs `backlog.md` BL-004 | Cron slot budget is stated as 3, 3 and 2 |
| `src/openclaw/docker-gateway.mjs:133` | `assertHostCapacity` has **no caller in `src/`**, yet `test/gateway-supervision.test.mjs:171-178` still asserts on its body |
| `migrations.mjs:17,21-24` | `PRE_COMMIT_STATES` / `POST_COMMIT_STATES` are exported with **zero call sites** |

## Open decisions for the user

| # | Decision | Where | Cost of getting it wrong |
|---|---|---|---|
| **D1** | Is the CAS expectation argument on `completeTurn` mandatory, or optional-with-default? | 01 | Mandatory costs ~20 mechanical test edits across 6 files |
| **D2** | A message arriving during a `WAITING_*` turn — coalesce, or open a new turn? | 02 | Silence changes `test/message-coalescing.test.mjs:26` behaviour silently; user messages can pile up behind an approval with no ack |
| **D3** | Lease TTL, who owns the clock, and the steal rule | 03 | Too short = split-brain; too long = a dead worker parks a tenant |
| **D4** | One migration or two for the widened CHECK plus the new tables | 02, 03, 05 | 002's rebuild once cascade-deleted every `turn_messages` row |
| **D5** | `DECISIONS.md:25` says recovery needs "**no tool-call ledger**". `run_steps` is one. Supersede it, or state why a step ledger is for observability and approval, never for recovery? | 05 | The single biggest decision-log collision in this change |
| **D6** | Does `UNCERTAIN_WRITE` get retired? `DECISIONS.md:27` calls it "a stop-gap, not the specified design" and names what the real design needs | 06 | The operator-resolution half is currently forbidden by `test/shutdown-backup-operator.test.mjs:210-214` |
| **D7** | `docs/ROCKY-codebase-audit.md` proposes **dropping the `cli-home` mount** for credential exposure. Slice 06 does not depend on it under the recommended design, but any hook-based fallback does | 06 | Two approved directions in direct conflict |
| **D8** | Pin the Claude CLI in the image? | 06 | `Dockerfile.openclaw:19` installs it unpinned; OpenClaw beside it is pinned and asserted |
