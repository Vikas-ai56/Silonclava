# Phases 4–7 — what each spec must cover

**Status:** input for future spec work. Not a spec. Written 2026-09-24 from the
research round of 2026-09-23/24 so that whoever specs these phases does not have
to re-derive the constraints.

Phases 1–3 (run states + leases, step ledger, verification gate) have their own
specs. These four build on them and can be specced in any order once 1–3 land.

---

## Constraints that bind all four

These come from Meta's own documentation and are not negotiable.

| Constraint | Value | Consequence |
|---|---|---|
| Send rate to one user | **1 message / 6 seconds** (~10/min) | Every message spent on progress is one not available for a result |
| Message ordering | **Not guaranteed** | Two agents reporting concurrently arrive scrambled. Sequence numbers in the text, not optional |
| Customer service window | **24 hours**, resets on any inbound | An agent finishing at hour 26 cannot send a plain message — needs an approved template |
| Reply buttons | **3 max, 20-char titles**, body 1024 | The approval card's shape is fixed by this |
| Sender identity | **One number = one sender.** No per-message name override | Agent identity must be synthesised in the message body. It is decoration, never identity |
| Mentions | **No entity object in 1:1** | `@name` is user-typed text we parse. Never authorisation |
| Typing indicator | **25 seconds**, cannot be read back | Decoration only. Cannot signal a long run |
| Webhooks | Retry 36h, **can duplicate** | Dedupe is our job |

Already decided and logged (`DECISIONS.md`, 2026-09-24): **the user receives
messages only for blocked / permission / final result / HITL.** Steps go to the
ledger and are read on demand.

---

## Phase 4 — Routing to a named agent

**The gap:** routing today is `phone/JID → tenant`, strictly one-to-one
(`src/tenants.mjs`). There is no second dimension for "which agent within this
tenant". That dimension has to be added.

**Decided:**
- Quoted reply → that agent. Primary mechanic. Native, discoverable, unambiguous.
- `talk to <name>` … `done` focus mode. Covers the phone-friction case where
  quoting every message is tedious.
- `@name` fallback for a fresh instruction, with fuzzy matching.
- Un-addressed → main agent. **Never "last speaker wins"** — that is a silent
  mis-routing source.
- Every reply prefixed with the agent's name, so a mis-route is visible on the
  first message rather than the fifth.
- Commands namespaced per agent from day one.

**Must be in the spec:**
- The plumbing already exists — `quotedMessage` / `quotedReplyPreamble`
  (`src/router.mjs:18-19`), `reply_to_external_id` on messages,
  `provider_message_id` on delivery attempts. Trace how these connect a quoted
  reply back to the agent that sent the original.
- `@name` is a hint, never a capability grant. Authorisation comes from the
  tenant's own record of which agents it has hired.
- What happens on an ambiguous or unknown name. Telegram's rule is worth
  copying: replies beat mentions, deterministically.

**Prior art worth reading first:** Telegram's `/command@botname` convention and
its exclusive-delivery rule are the closest fit, because Telegram is text-only
like us. Slack and Discord solve this with platform primitives we do not have.

---

## Phase 5 — Approvals

**Decided:**
- An approval carries a **hash of the exact payload shown to the user**. Re-hash
  at execution; a mismatch is a denial, not a warning.
- Three buttons: Allow once / Always allow / Deny. This fits WhatsApp's limit
  exactly — a free fit, not a compromise.
- Rule precedence: **ask-first wins** when two rules match.

**Must be in the spec:**
- **Approval governs the next action only. It does not reverse anything already
  done.** State this in the spec and in the user-facing text. If an agent does
  five things then asks about the sixth, denying the sixth undoes nothing.
- Anything irreversible must ask **before** acting, never report after.
- The approval message must be self-contained. Hours can pass before the tap, and
  the user will have lost the context.
- A reaction is never a decision. Never accept 👍 as approval.
- Where the approval record lives, and how it relates to the lease and the step
  ledger from phases 1–2.

---

## Phase 6 — Cron

**More is already built than is obvious.** Before speccing, read:
`src/tenant-data/cron-store.mjs`, `src/wake-scheduler.mjs`, `src/cron-ingress.mjs`,
`src/cron-ingress-listener.mjs`, and migration 003 in `src/tenant-data/migrations.mjs`
(`cron_schedule_mirror`, `cron_duration_model`).

**What exists:** the host-owned schedule mirror, wake scheduling with slots and
overrun preemption, the webhook delivery path back from the container, and the
duration model. Four test files cover them in isolation.

**What does not exist:** any way to create a job. Nothing in Rocky writes one —
the design mirrors OpenClaw's cron DB, so a job must be created inside the
container. **Zero jobs have ever existed in production** (`openclaw cron list` →
"No cron jobs"), so the whole pipeline is untested end to end.

**Decided:** Rocky owns the job record; cron becomes a **trigger that enqueues a
leased run**, never an executor. That puts it under the same dedupe, retry and
reconcile guarantees as everything else and removes OpenClaw's scheduler from the
correctness path — which matters, because that surface has 2% vendor QA coverage,
caps missed runs at 5 per restart, coalesces them silently, and alerts nobody by
default.

**Must be in the spec:**
- What happens to the existing mirror — does it invert, or is it removed?
- The creation path, including from chat.
- A cron result arriving after the 24-hour window has closed.
- The first end-to-end test with a real job.

---

## Phase 7 — Class A agents

**Class A = a named role inside the tenant's existing container**, sharing its
Claude session. Class B (own container) is deferred until a task genuinely runs
for hours.

**Decided:**
- **Creation is always a user action.** The main agent never spawns one on its
  own initiative.
- An agent may request a new agent via an `actionRequest` to the main agent,
  which **asks the user**. Every agent is therefore structurally a child of main:
  runtime depth stays 1 while the logical tree can be any shape.
- Two fields: `requested_by` (logical parent, for audit) and `spawned_by`
  (always main, for containment).

**Must be in the spec:**
- **Tool allowlist fixed at spawn, enforced host-side** — in the MCP projection,
  not in a prompt. We already have that machinery.
- **No credential read-through.** If an agent's scoped credential expires it
  fails; it must not inherit the main agent's. This is exactly the OpenClaw
  defect that ruled out native agents.
- **An agent's output is data, never instructions** to the parent. It arrives as
  tool output, the lowest privilege tier.
- **An agent cannot deliver to the user** — only the main agent sends.
- **An agent cannot approve anything**, including its own actions.
- **Budget: step count, token count, wall-clock.** Exceeding it terminates; it
  does not request an extension.
- **Loop safeguards** for agent-to-agent messaging, copied from the only
  first-party contract that exists (Telegram's): dedupe repeated messages,
  per-pair rate limit, maximum interaction depth, timeout.
- Class A shares the tenant's transcript. If Class B is ever built, it needs its
  own, with only a summary crossing into the user's conversation — otherwise a
  long run floods the user's context.

---

## Facts worth not re-deriving

- **Agents lie about completion at scale.** False success is 45–48% of failures
  on τ²-bench and 75.8% on AppWorld. Agents misled users in 80.4% of incomplete
  runs. Self-reports referenced about one action in eleven, and drifted toward
  stated intent as execution diverged from plan.
- **Do not build an LLM judge to detect it.** AUROC 0.54–0.65 across five judges
  and five prompt strategies — near coin-flip. A TF-IDF detector beat them 4–8×
  at 3,300× lower latency. Verify against environment state, not narration.
- **Anthropic's Claude Opus 5 System Card** records that the model "can relay
  claims from subagents to users without verifying them".
- **A Claude CLI session is one portable JSONL file**, resumable in a fresh
  container. Credentials do not travel; the prompt cache does not travel;
  `--continue` is cwd-keyed and fails *silently* into a new session. Two
  processes resuming the same session id fork the history with no error.
- **Suspend/resume is deliberately out of scope.** At p95 = 1 agent the headroom
  is 5–100×, and `docs/features/10-admission-and-eviction.md` already lists
  snapshot/suspend as a non-goal. Revisit only if resident agents sustain ≥ 20.

---

## Open questions these specs must resolve or escalate

| # | Question | Affects |
|---|---|---|
| Q1 | How does a user discover `@name` and focus mode at all? | 4 |
| Q2 | What does an agent do when it finishes after the 24-hour window closes — template, or hold until the user speaks? | 5, 6, 7 |
| Q3 | Does the existing cron mirror invert to an outward projection, or get deleted? | 6 |
| Q4 | Where does a hired agent's roster live, and is it per-tenant config or a table? | 4, 7 |
