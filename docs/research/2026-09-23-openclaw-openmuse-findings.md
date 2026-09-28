# OpenClaw reliability and OpenMuse patterns — findings

**Date:** 2026-09-23
**Question it answers:** can the Bot-agent control plane rest on OpenClaw's native
`agents` / `subagents` / `cron` / `memory` / `approvals`, and what should we borrow
from OpenMuse instead?
**Verdict:** no. Use OpenClaw as a per-tenant Claude CLI runner; put the control
plane in Rocky next to the turn ledger.

## Method and how far to trust this

Part A is static analysis of OpenClaw's bundled JS, config schema, docs and public
issue tracker, plus direct inspection of our live tenant. Where a claim was checked
against the running deployment it is marked **[verified live]**. Nothing in Part A
was established by runtime or behavioural testing — no container was started,
restarted or modified to produce it.

Part B is DeepWiki analysis of `CopilotKit/openmuse`, which is grounded in that
repository's source. Treat exact field and method names as reliable and exact line
numbers as not checked.

Findings that would change a decision if wrong are flagged **[load-bearing]**.

---

# Part A — OpenClaw native features

## A1. The vendor's own scorecard rates the project Alpha

68% overall. Every surface we would depend on sits at M3/Beta. **[load-bearing]**

This is the single most useful number in the audit because it is the vendor's own
assessment against their own criteria, which is evidence against interest. It
reframes everything below: these are not bugs to be reported and fixed, they are
the expected condition of a project at this maturity band.

## A2. Automation has 2% QA coverage; WhatsApp has 0%

Cron and tasks — the surfaces our scheduling depends on — carry 2% coverage and no
LTS commitment. The WhatsApp surface, our only transport, carries none.

A coverage number this low does not predict specific failures. It predicts that
failures will be found by us, in production, rather than by the vendor.

## A3. `impact:message-loss` is a standing label with 591 open issues

Not an incident count — a *category*. A project that needs a permanent label for
lost messages is telling you that message loss is an ongoing design property, not
a regression. This is the most direct evidence against putting delivery guarantees
on OpenClaw's side of the line.

## A4. Subagent completion is silently lost — P1, unassigned since 2026-03-13

Issue #44925. No retry, no notification. **[load-bearing]**

This is precisely the "report that this job is done" step required for Bots. It is
open, it is priority one, and nobody is assigned. See B7 for the pattern that
fixes it, which OpenMuse implements and OpenClaw does not.

## A5. Exec approvals are off in our deployment **[verified live]**

Build constants are `DEFAULT_SECURITY="full"`, `DEFAULT_ASK="off"`. Our tenant's
complete config key set is `[agents, cron, gateway, logging, mcp, plugins, session,
skills]` — no `tools`, no `approvals`, no `diagnostics` block — and
`exec_approvals_config` has zero rows. **[load-bearing]**

The mechanism is sound and fails closed *once you opt into asking*. We never ask.
The fail-closed `deny` governs only the timeout of a prompt already raised. This
was initially reported to us as a strength; it is not one as configured.

## A6. Approval decisions are never persisted

Pending approvals live in an in-memory map and are lost on gateway restart.
Decisions emit as in-process diagnostics whose only durable sink is OpenTelemetry,
and we have no exporter configured. **[load-bearing]**

Consequence for a regulated firm: we can show *that* an action ran, for 30 days.
We cannot show what was approved, by whom, or that anyone approved it. That is not
an evidential standard. See B10 for the alternative.

## A7. The audit ledger records two event kinds, expires at 30 days, and stores
phone numbers in plaintext

`audit_events` holds only `agent_run` and `tool_action`. `session_key` embeds the
phone number unredacted. Retention is 30 days.

Two separate problems: insufficient coverage for an audit trail, and PII sitting in
a key field where it will be copied into logs and backups by anything that touches
the row.

## A8. Cross-agent OAuth read-through **[load-bearing]**

`concepts/multi-agent.md:32` — when a secondary agent's credential is expired or
refresh fails, OpenClaw reads through to the **main agent's** credential for the
same profile and adopts whichever token is freshest.

This is the finding that disqualifies native agents as an isolation boundary. A
credential crosses an entity boundary automatically, on expiry, with no operator
action and no failure. For a Bot scoped to one calendar, the scoping evaporates at
the exact moment its own token lapses.

## A9. An agent's workspace is not a sandbox

`multi-agent.md:38` — absolute paths reach other host locations unless sandboxing
is separately enabled. The isolation people assume from "each agent has a
workspace" is a default working directory, nothing more.

## A10. WhatsApp access control is global per account, not per agent

`multi-agent.md:197`. Also `:166-168` — direct chats collapse to the agent's main
session key by default, so true isolation requires one agent per person.

## A11. Per-agent subagent limits cannot be expressed

`maxSpawnDepth`, `maxChildrenPerAgent`, `maxConcurrent` and `runTimeoutSeconds` are
read **only** from `agents.defaults.subagents.*`. The per-agent schema is `.strict()`
and accepts only `delegationMode, allowAgents, model, thinking, requireAgentId`;
attempting to tighten a limit for one agent is a validation error. **[load-bearing]**

You cannot constrain one untrusted Bot more than the fleet. Any containment must
therefore be structural, not configured — which is what routing all spawns through
a single actor achieves (see C3).

## A12. `maxConcurrent` is a queue, not a cap

Excess spawns accumulate in an unbounded in-memory array with no depth limit. All
queued work is lost on restart. A setting that reads like a limit is actually an
unbounded buffer with a lossy failure mode.

## A13. Everything except workspace, agentDir and transcripts is one shared database

`subagent_runs`, `task_runs`, `audit_events`, `cron_jobs`, `exec_approvals_config`,
delivery queues and pairing all live in a single SQLite file, 70+ tables, across
all agents.

## A14. Memory has produced nothing in our tenant **[verified live]**

No `MEMORY.md`, no index, no consolidation. `dreaming.enabled` defaults false and
our config shows `plugins: {entries: {}}`, confirming it.

Separately: we execute through the Claude CLI, so OpenClaw's memory is not on the
execution path at all. Adopting it means adopting its consolidation daemon, for a
subsystem whose current measured output is zero.

## A15. Cron drops missed runs silently, and reports failures to nobody

Missed runs are capped at 5 per restart and coalesced. `cron.failureAlert.enabled`
defaults false. Combined with A2 (2% coverage) this is the least trustworthy
surface in the stack, and we have no creation path for cron in Rocky anyway.

## A16. The docs recommend substituting an LLM for the human approver

`tools.exec.mode: "auto"` enables a native LLM auto-reviewer that decides approval
misses itself and defers to a human only when it cannot safely approve.
`tools/permission-modes.md:20` recommends it.

Flagged not as a bug but as a control-design question. For a regulated firm this is
a decision to be taken deliberately, not inherited from a documentation default.

## A17. A denial is not reported back to the denied session

`tools/exec-approvals.md:479` — a denial for a subagent or cron session is not
posted into that session. The child never learns it was denied and cannot react.

## A18. Genuine strengths, worth preserving where approvals are switched on

Effective policy is the stricter of `tools.exec.*` and the approvals file, so
approvals can only tighten, never loosen. YOLO requires opening both layers.
Request mutation after approval is rejected as a mismatch. A bound file changing
between approve and exec denies the run. Safe-bin argv validation is fail-closed.
OpenClaw policy overrides raw Claude CLI `--permission-mode` arguments.

The mismatch rejection is the same instinct as B10, arrived at independently.

## A19. Our version pin contradicts the decision log **[verified live]**

`src/config.mjs:102` and `Dockerfile.openclaw:9` both say `2026.7.1-2`.
`DECISIONS.md:38` claims we pinned to `2026.7.33 (extended-stable)` and that a test
holds them together. `extended-stable` is now `2026.7.35`.

Either the bump never landed or the log is wrong. Unresolved — needs a decision,
not a guess.

## A20. The single root cause behind most of the above

Our tenant config is nearly empty, so the deployment runs on code defaults: no exec
approvals, no approval audit sink, no memory consolidation, no cron failure alerts,
no subagent timeout. None of these announce themselves. Written up as rule 8 ("a setting you never wrote is a setting someone else chose") in `docs/PATTERNS-durable-work.md`.

## A21. Ruled out, and separately: the Node NUL-truncation report does not apply

Reported as the most severe finding; it is not one for us. Our host runs v22.22.1,
outside the affected range. The container runs the affected v22.23.2, but Rocky's
vault envelopes are base64url JSON and structurally cannot contain NUL bytes. Both
checked directly.

Recorded because a dismissed finding should be dismissed *on the record*, with its
reasoning, so it is not re-litigated later.

---

# Part B — OpenMuse patterns worth borrowing

## B1. Leases live in the work row itself

`tasks` carries `leaseId` and `leaseUntil`, both null at creation. No separate lock
table, no external coordinator. Ownership is an attribute of the work.

## B2. A lost lease is an explicit error, not a silent no-op

`LostLeaseError` is raised when a compare-and-swap against the lease fails, and the
worker immediately stops touching that task. The alternative — discovering you no
longer own the work by having your writes quietly ignored — is how double execution
becomes invisible.

## B3. Leases are cleared explicitly on pause, cancel and retry

Reclaim is a state transition, not merely expiry. Expiry is the *backstop* for a
crashed worker, not the normal path. This matters: a design that only reclaims on
expiry makes every operator action wait out a timeout.

## B4. Every status transition is a compare-and-swap on `(status, leaseId)`

Failure surfaces to the user as "refresh and try again" rather than silently
overwriting. Written up as rule 5 ("write down which state you expected") in `docs/PATTERNS-durable-work.md`.

## B5. The embedded database cannot be shared across processes

`docs/VERIFICATION.md` states it plainly: PGlite cannot be opened by separate
processes; a separate worker requires real PostgreSQL. **[load-bearing for us]**

Directly applicable — our `better-sqlite3` has the identical constraint. Any
decision to run a Bot worker as a separate process collides with this immediately,
and it is cheaper to know now than after the process split.

## B6. Leases use wall-clock time with no skew handling

`Date.now()` throughout, no compensation. A real footgun in the design we are
copying, unacknowledged in the source. Single-host deployment makes it moot for us
today; it stops being moot the moment there are two hosts.

## B7. Outcome publication is separate from task completion

`publishOutcome` runs from a `settled` callback, distinct from the write that marks
the task finished. **[load-bearing]**

The reasoning: a process can crash after committing `succeeded` but before
notifying, leaving a state that is internally correct and externally invisible.
This is exactly A4, the OpenClaw defect that is still open. Written up as rule 2 ("finishing a job is two steps") in `docs/PATTERNS-durable-work.md`.

## B8. The reconcile loop re-publishes everything unconditionally

Every 60 seconds, `maintain` walks all tasks and calls `publishOutcome` on each.
There is no "needs publishing" flag, because that flag would be one more write
lost in the same crash. Idempotence plus unconditional replay removes the need to
detect the gap at all.

The absence of the flag is the insight, not the loop.

## B9. Checkpoints are written at irreversible boundaries

`TaskContext.checkpoint()` durably writes partial state: `actionId` after proposing
an action, `approvalResult` after approval, artifact ids after each step. Resume
rebuilds context purely from the durable row, with no in-memory reconstruction.

This is the prerequisite for releasing a container while work is suspended — the
run must be reconstructible from storage alone.

## B10. Approval is a separate entity carrying a content hash

`ActionProposal` holds `id, hash, status, taskId, title, account, result, error`.
The decision call is `decide(owner, id, hash, action)`. **[load-bearing]**

The hash is the best idea in the repository. It binds the human's decision to the
*content they were shown* rather than to a row that anything could subsequently
edit. It is also exactly the gap in A6 — an approval record that can answer what
was agreed to. Written up as rule 3 ("approve the thing, not the row it sits in") in `docs/PATTERNS-durable-work.md`.

## B11. Approval states are `awaiting_review → executing → succeeded`

The task sits at `waiting_approval` with `actionId` linking to the proposal,
cleared to null on resume. The proposal has its own lifecycle, so "the action was
approved" and "the task resumed" are separately observable.

## B12. Retrying a task whose action is awaiting review is refused

Raises an error rather than proceeding. Prevents the double-dispatch that occurs
when a retry rebuilds a request that is already pending human review.

## B13. Cancelling a task auto-denies its pending proposal

Cleanup of the approval is part of cancellation, not a separate reconciliation.

## B14. An already-dispatched request may still complete after cancellation

Documented, not fixed. `docs/VERIFICATION.md` states it. Honest scoping of what
cancellation can and cannot promise — cancellation is not recall.

## B15. No hidden retry after an uncertain external write

From the README: *"No hidden retry occurs after an uncertain external write. Review
its provider outcome before creating a replacement."*

Matches our existing `DELIVERY_UNKNOWN` state and our **P3**. Independent
convergence on the same rule is the strongest evidence available that it is right.

## B16. The idempotency key is hashed into the primary key

Not a separate dedupe table and not a read-then-write check. Duplicate creation
collides at the primary key and returns the existing row. Same mechanism for
monitors. Written up as rule 4 ("let the database enforce only once") in `docs/PATTERNS-durable-work.md`.

Cheaper and less racy than our current `request_id` check.

## B17. States: `queued, paused, waiting_approval, waiting_input, scheduled,
succeeded, failed, cancelled`

Terminal: the last three.

## B18. `waiting_input` is distinct from `waiting_approval`

Asking the user a question is modelled separately from asking permission. Different
resumption conditions, different escalation, different meaning for an auditor.
Written up as rule 9 ("name a waiting state after whatever ends the wait") in `docs/PATTERNS-durable-work.md`.

## B19. Monitor retries back off exponentially, cap at 60 minutes, auto-pause at 5
consecutive failures

A bounded retry policy with a terminal state, rather than indefinite retry.

## B20. The honest negative: OpenMuse has no sub-agents at all

No parent/child runs. Tasks associate with a `goalId`, not a parent task.
Communication is in-process plus database polling. There is no websocket, no queue
and no message bus between agents. The worker *can* run as a separate process and
still coordinates solely through SQL leases. **[load-bearing]**

Stated prominently because the quality of B1–B19 invites the assumption that
OpenMuse solved agent-to-agent coordination. It did not address it. It is a strong
model for durable single-agent execution and no model at all for multi-agent
communication.

Read the other way, it is still evidence: a team that built this carefully chose
durable state plus a reconcile loop over a message transport. Written up as rule 6 ("a ping can be missed") in `docs/PATTERNS-durable-work.md`.

---

# Part C — What this changes for Rocky

## C1. Ruled out: OpenClaw native agents as the Bot boundary

On A8 alone (credential read-through across the boundary), reinforced by A9, A10,
A11 and A13. The decision is not about quality; the boundary does not exist in the
place we need it.

## C2. Rocky owns the control plane; OpenClaw stays a Claude CLI runner

Rocky already holds the durable turn ledger, per-tenant containers, request dedupe
and AEAD transcripts. What is missing is work-shaped state, which is a schema
change rather than an infrastructure change. The parts OpenClaw is weakest at are
precisely the parts we already own.

## C3. Bots may spawn Bots, via an actionRequest to the spawning main agent

Every Bot is therefore structurally a child of main: runtime depth stays 1 while
the logical tree may be any shape. This is what makes A11 survivable — containment
becomes structural rather than configured, so it does not depend on a per-agent
limit OpenClaw cannot express.

Requires two fields: `requestedBy` (logical parent, for audit) and `spawnedBy`
(always main, for containment).

## C4. Leases, not slots

Only a genuinely running Bot holds a container. `WAITING_SUBRUN`,
`AWAITING_APPROVAL` and `RETRY_WAIT` hold a lease and release capacity. A Bot
waiting hours on a human costs bytes. Depends on B9. Written up as rule 1 ("waiting work should not hold onto expensive things") in `docs/PATTERNS-durable-work.md`.

This also corrects the current container cycle, which keys hibernation on
inactivity and can therefore evict a container that is mid-run.

## C5. Rocky's SQLite is the bus; the existing per-container WebSocket is the
doorbell

No ZMQ. A new daemon, port and failure mode buys latency we do not need at p95 = 1
Bot, and provides no durability or reconcile story. The notification carries no
payload of record. Same rule 6 as above.

## C6. Cron becomes a trigger that enqueues a leased run

It should not execute anything directly. That places it under the same dedupe,
retry and reconcile guarantees as all other work, and removes OpenClaw's scheduler
(A15, A2) from the correctness path.

## C7. Two gaps in what we have already built

Both are small and both are worth closing: we have no approval content hash (B10),
and our `request_id` dedupe is a separate check rather than a primary-key collision
(B16). Our `SEND_STARTED` / `DELIVERY_UNKNOWN` states already match B7 and B15,
reached independently.

---

## Open questions

- **A19** — which version pin is intended. Needs a decision.
- **A16** — whether an LLM auto-reviewer is acceptable in any Rocky approval path.
- **B6** — clock skew is harmless on one host and is not harmless on two. Decide
  before there is a second host, not after.
- Hardware substrate (microVM / Lambda) deferred by agreement; Docker confirmed for
  now.
