# 90 — Four invariants that exist only in code and tests

**Status:** SPEC, not built. No code change. Do this **first** — the other slices
cite these. Grounded against `ea23eca`.

## Problem, restated after drift analysis

`docs/README.md:27-32` says the deleted phase specs' section numbers "now resolve
through `DECISIONS.md`, which records the same requirements with their reasoning."

**That claim is materially false for four sections, and thin for three more.**
The audit checked every distinct `SPEC-phase3c` section cited in `src/` (29
citations, plus ~55 bare `§n` references) against `DECISIONS.md`.

Worse, `DECISIONS.md:1090-1093` says the deleted specs are recoverable "from git,
the rest from the copy on the production host". **Neither is true:**

- `SPEC-phase3c*`, `PREFLIGHT-phase3c.md`, `HANDOFF-phase3b.md` and
  `BRIEF-phase3-onwards.md` were **never committed** — zero hits across all refs.
  Only `PLAN.md` is in git history.
- `docs/` is **not** in `deploy/rsync-exclude.txt`, so `rsync --delete-after` has
  removed the prod copies on every deploy since 2026-09-20.

**They are gone from prose. They are not lost** — each is pinned by a test
carrying the same section number, which is the real recovery path the README never
mentions.

## Genuinely absent from `DECISIONS.md`

| # | Invariant | Recoverable from |
|---|---|---|
| **R1** | **The model call resolves on terminal completion only, and a turn is never retried in-turn (§2).** A pause in deltas is not a finished response; a second attempt hides the failure from the durable layer, bills a second model call, and makes the turn non-atomic | `tenant-openclaw.mjs:664-671`, `:847-851`; `test/gateway-supervision.test.mjs:85-104` |
| **R2** | **OpenClaw's session is a cache; the durable transcript is the memory (§1.5).** Runtime-native history "may compact, prune, reset, or change format" — the premise the whole transcript design rests on. `DECISIONS.md:17` still says the transcript is "not implemented until Phase 3C" | `context-store.mjs:6-14`; `test/docker-runtime-fixes.test.mjs:90`; `docs/features/03:3` |
| **R3** | **The privacy guard's blocked classes, and that ordinary personal data is allowed (§7).** Authorization codes, passwords, API keys, tokens, cookies, private keys, payment-card secrets block the send; ordinary personal data is allowed and encrypted. Only the *block-don't-redact* rule is recorded (`DECISIONS.md:31`) — **the class list is not** | `policy-guard.mjs:2-12`, `:106`; `CODEBASE.md:69`; `test/tenant-data-store.test.mjs:234` |
| **R4** | **The turn envelope is immutable (§5).** Recipient frozen at enqueue, runtime id/generation stamped at claim and validated at completion, `StaleTurnResultError` | `migrations.mjs:159-162`; `queue-store.mjs:107-109,134-137,196-202`; `test/turn-correlation.test.mjs:36-124` |

## Thin — present elsewhere, not in the decision log

| # | Invariant | Where it survives |
|---|---|---|
| R5 | **Never edit a shipped migration's SQL** (§4) | `migrations.mjs:35`; `docs/features/03:18-19`; enforced `:294-300` |
| R6 | The measured SQLite pragma values and why — `journal_size_limit` 64 MiB after a leaked reader grew a WAL 3.94 MB → 247 MB; `cache_size -2000`; `busy_timeout 250` | `open.mjs:14-18` |
| R7 | **Boot order**: reconcile containers → supervisor → wake scheduler → recover lanes → resend, all before the channel accepts traffic | `index.mjs:136-174`; `test/wiring-regressions.test.mjs:16-20`; half-stated at `features/01:58` |
| R8 | `turn resolve` **throws with an explanatory message** rather than simply not existing. `DECISIONS.md:52` says it is absent, not that it errors | `resources/turn.mjs:26-30`; `test/shutdown-backup-operator.test.mjs:210-214` |
| R9 | The `.prepare()` and `new Database(` bans are enforced by **text-scanning tests, not lint** — and the recorded reason is stale: `DECISIONS.md:30` says "the repo has no lint toolchain", but `package.json` has `eslint ^9.39.5` and a `pretest` hook | `test/gateway-supervision.test.mjs:181-202`; `test/tenant-data-store.test.mjs:330-355` |

## Corrections to land at the same time

| # | Correction |
|---|---|
| R10 | **Cron slot budget disagrees three ways** — 3 (`DECISIONS.md:42`), 3 (`features/07:33`), 2 (`backlog.md` BL-004). One is wrong |
| R11 | `docs/features/10-admission-and-eviction.md:3` says "Status: spec … Implementation follows this document". **It is implemented** (`src/openclaw/admission.mjs`, `DECISIONS.md:1482`) |
| R12 | `docs/features/03:30,39-48` still documents `search-store.mjs`, deleted 2026-09-22 (`CODEBASE.md:172`) |
| R13 | `DECISIONS.md:1090-1093`'s recovery claim is false — see above |
| R14 | `assertHostCapacity` (`tenant-gateway.mjs:133`) has **no caller in `src/`**, yet `test/gateway-supervision.test.mjs:171-178` still asserts on its body. A dead function held alive by a test |
| R15 | `docs/README.md:19-20`'s **Living** list omits `PATTERNS-durable-work.md`, `specs/` and `research/`. `PATTERNS-durable-work.md` is the normative source for this entire suite and must be listed |

## Per-file change map

No source changes. `docs/DECISIONS.md` gains R1–R9 as retroactive entries in the
standard four-part form. R10–R15 are corrections in place across `docs/README.md`,
`docs/features/03`, `docs/features/07`, `docs/features/10`, `docs/backlog.md` and
`docs/DECISIONS.md`.

## Done criteria

- Every `§n` cited in `src/` resolves to something written down.
- `docs/README.md:27-32` says section numbers resolve through **DECISIONS.md and
  the tests that carry the same numbers** — which is the truth.
- The false recovery claim at `DECISIONS.md:1090-1093` is corrected.
- No correction in R10–R15 is left as "we know about it".
