# 05 — The step ledger and `status`

**Status:** SPEC, not built. Grounded against `ea23eca`. Depends on **02**
(needs the waiting states) and **03** (a step ledger without a lease has no owner).
Not security-sensitive on its own; **06** makes it so.

## Problem, restated after drift analysis

There is no notion of intermediate progress within a turn. The only in-turn
capture point is the deferred channel (`src/channel.mjs:58-79`), which buffers
whole utterances, not steps. `context_checkpoints` (`migrations.mjs:125`) is
*conversation summarisation* through a sequence number and must not be conflated
with this. `runOpenclawTurn` returns a bare string (`tenant-openclaw.mjs:793`).

And the user will see nothing: the logged decision of 2026-09-24 is that messages
go out only at blocked / permission / result / HITL points. **So the ledger is the
only progress record, and `status` is not optional — it is the read side of this
table.**

**Where a step can be recorded — four candidate seams, ranked:**

| Seam | Where | Assessment |
|---|---|---|
| Agent MCP tool | `src/agent-mcp.mjs:184-210` | **Recommended.** Already mid-turn, already tenant-scoped from the bearer token, already default-deny |
| Deferred channel | `src/channel.mjs:58-79` | Cheapest seam with a store in scope (`router.mjs:396`), but per-utterance, not per-step |
| SSE loop | `tenant-openclaw.mjs:689-725` | Highest fidelity, but only three event types are consumed and nothing carries a store handle down that path |
| Turn boundaries | `inbound-queue.mjs:165`, `router.mjs:491` | Too coarse — that is what already exists |

## Design

**`run_steps` keyed on the run, not the turn.** Columns: `run_id`, `idx`, `title`,
`status`, `declared_at`, `completed_at`, `evidence`. The agent declares its steps
up front; each write is a durable checkpoint.

**Step payloads are sealed.** `test/step7-live-gates.test.mjs:180-197` makes AEAD
sealing effectively mandatory for anything carrying model-authored text, and step
titles and evidence are exactly that. Use the existing envelope
(`src/privacy/aead.mjs`) with its own record name.

**`declare_steps` / `complete_step` are agent MCP tools** backed by a `step`
resource with `agentActions`. The default-deny posture is already correct: until
the resource declares `agentActions`, the call throws
`Agent grant does not permit …` (`authorization.mjs:59`) and the model sees an
`isError` result, not a crash (`test/agent-scope.test.mjs:57-65`).

**`status` is reachable three ways** and therefore needs `tenantSelfService: true`
plus `tenantActions` (the WhatsApp path goes through `createTenantClient`),
`agentActions` (model readback) and `requiresTenant: true`.

**Two traps found in the analysis:**

- `createTenantAgentClient` returns `Object.freeze(...)` and deliberately exposes
  only `session` and `mcp` (`client.mjs:78-90`). Adding a step surface means
  editing that frozen object, and the design note at `:65-70` explains why it is
  narrow. Widen it deliberately, not incidentally.
- **`redactParams` will silently redact step fields.** `audit.mjs:5` matches keys
  against `token|secret|…|code|…|^(raw|input|paste|value)$`. **A step field named
  `code` or `value` would render as `[REDACTED]` in CLI output.** Name the columns
  to avoid it.

**D5 — the decision-log collision.** `DECISIONS.md:25` states recovery needs
"**no tool-call ledger for recovery**". `run_steps` is a tool-call ledger. Either
that entry is superseded, or this spec states plainly that the step ledger exists
for observability and approval and is **never** read by the recovery path. The
second is recommended and must be written down, because the first would reopen the
total-re-execution design.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/migrations.mjs` | `run_steps` table | Medium |
| new `src/tenant-data/run-step-store.mjs` | Must live under `src/tenant-data/` | Medium |
| new `src/tenant-cli/resources/step.mjs` | `declare` / `complete` / `show` | Medium |
| new or extended `status` resource | The read side | Medium |
| `src/tenant-cli/registry.mjs` | Definitions with the three grant kinds | Medium |
| `src/tenant-cli/client.mjs:78-90` | Widen the frozen agent client | **High** — deliberate narrowing |
| `src/agent-mcp.mjs:19` | Two new tools | Medium |
| `src/tenant-cli/result.mjs:4-34` | Projection branch; avoid the redaction trap | Medium |

**Boundary:** `test/tenant-control-plane-boundary.test.mjs:31-44` matches **raw
file text**, so even a comment containing `tenant-cli/resources/` trips it. The
step surface is reachable from `src/**` only via `client.mjs` or `index.mjs`.
**Tool naming:** `test/agent-mcp.test.mjs:48-53` forbids any tool name containing
`disconnect|vault|delete|route|tenant`. `complete_step` is fine.

## Invariants preserved

- Tenant identity comes from the bearer token, never the payload
  (`agent-mcp.mjs:155-158`).
- Agent grants are default-deny.
- No plaintext model-authored text at rest.
- Recovery reads only the inbound message(s) and the committed response — see D5.

## Tests

- A declared plan survives the container being destroyed.
- `status` returns the full step history for a finished run.
- The step tools are refused before `agentActions` is granted.
- Step titles and evidence are sealed at rest.
- No step field renders `[REDACTED]` in CLI output.

## Docs in the same PR

- `docs/features/01-inbound-turn.md:61-68` — boundaries table gains the step record.
- `docs/features/03-persistence-and-context.md:10-16,23-32` — migration row and the
  new store module; fix the stale `search-store.mjs` references at `:30,39-48`.
- `docs/CODEBASE.md:196-198` — table list.
- `docs/backlog.md` BL-002 — `run_steps` is a **new record class**; its retention,
  subject-rights status and regulatory scope are open questions.
- `DECISIONS.md` — the table, its sealing, and **D5**.

## Done criteria

- A run's step history is queryable after its container is gone.
- `status` works from chat, CLI and the model.
- Steps are sealed; nothing is redacted by accident.
- D5 is answered in writing.
