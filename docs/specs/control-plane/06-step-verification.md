# 06 — Verifying a completion claim

**Status:** SPEC, not built. Grounded against `ea23eca`. Depends on **05**.
**Security-sensitive — second reviewer required.**

## Problem, restated after drift analysis

Agents claim work is done when it is not, at a rate that makes self-reporting
useless as a control signal: false success is 45–48% of failures on τ²-bench and
75.8% on AppWorld; agents misled users in 80.4% of incomplete runs; self-reports
referenced about one action in eleven and drifted toward *stated intent* as
execution diverged from plan. Anthropic's own Claude Opus 5 System Card records
that the model "can relay claims from subagents to users without verifying them".

**The original design — a `TaskCompleted` hook with exit 2 — does not work here,
and the analysis is what showed it.** Two independent reasons:

1. **The container can rewrite its own hook config.** OpenClaw forces
   `--setting-sources user`, so project settings are never loaded and hook config
   must live at `tenants/<id>/cli-home/claude/settings.json`. That path is mounted
   `:rw` (`docker-gateway.mjs:304`) and `grantTree` grants the container user
   group-write (`:262-264`). **A veto whose config the vetoed party can edit is not
   a control.**
2. **The hook's only credential is the agent's own.** The container cannot reach
   the host ledger — `tenants/<id>/data` is absent from `tenantMountSpec`, and
   `test/container-mounts-contract.test.mjs:19-25` asserts exactly four mounts. So
   a hook must verify over the network, using the bearer token from
   `/run/rocky-input/composio.json` — the same `agentToken` already in the model's
   MCP config. **A hook authenticating with it is indistinguishable from the agent
   it is meant to police.**

## Design

**Verification is host-side. The veto is structural, not a hook.**

`complete_step` is an agent MCP tool. Rocky verifies *before* recording. The only
way to mark a step done is to ask the host, and the host can say no. This needs no
new transport, no new mount, and no credential the model can reach — because the
decision is not made where the model runs.

A failed verification returns `isError: true` inside a 200 result
(`agent-mcp.mjs:200-209`), which the model reads and can act on. That is the
existing failure contract.

**What "verify" means, concretely:**

| The step claims | Rocky checks |
|---|---|
| Sent a message | A `delivery_attempts` row with a provider message id for this run |
| Created a calendar event / external record | Fetch it back by id through the connector |
| Wrote or changed a file | The workspace snapshot differs, and the hash changed |
| Called a tool | A matching tool call exists in this step's window |

**Unverifiable steps are logged, not gated — and this is stated in the code, not
glossed.** "Researched the market" has nothing to check. Gating it would either
block legitimate work or teach the agent to phrase every step as unverifiable. The
value is that the *dangerous* steps are exactly the verifiable ones.

**Second layer, cheap: reconcile the declared plan against the observed tool-call
log.** If a step flips to done and no tool call in its window did anything
relevant, flag it. This is a diff, not a model call.

**Do not build an LLM judge.** Across five judges and five prompt strategies, no
configuration exceeded AUROC 0.65 — near coin-flip. A TF-IDF detector reached
0.83–0.95 and recovered 4–8× more false successes at 3,300× lower latency. Verify
against environment state, not narration.

**The `TaskCompleted` hook is optional defence-in-depth, not the mechanism.** If
it is added later it needs, at minimum: a credential the model cannot read, and
config the container cannot write. Neither exists today.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-cli/resources/step.mjs` | `complete` gains verification before recording | **High** — security boundary |
| new verification module | Per-claim-type checks; unverifiable is explicit | **High** |
| `src/tenant-data/run-step-store.mjs` | `evidence` records what was checked and the outcome | Medium |
| `src/agent-mcp.mjs` | `complete_step` returns `isError` on refusal | Medium |

No mount changes. No hook config. **No fifth mount** —
`test/container-mounts-contract.test.mjs:19` asserts exactly four.

## Invariants preserved

- Tenant identity from the bearer token, never the payload.
- A refusal is a tool result, not a transport error (`agent-mcp.mjs:206-207`).
- Default-deny on agent grants.
- **New:** a verification decision is never made inside the container.

## Risks

- **The agent can still lie about an unverifiable step.** Accepted, and stated.
  The mitigation is scope: unverifiable steps must not be the ones that touch the
  outside world.
- **Verification cost.** Fetching an external record back on every completion adds
  latency and API calls. The spec should allow a per-claim-type opt-out with the
  reason recorded.
- **D6 — `UNCERTAIN_WRITE`.** `DECISIONS.md:27` calls it "a stop-gap, not the
  specified design", and says §6 required "either per-tool idempotency keys or the
  `uncertain` state plus an operator resolution path; neither exists". Leases +
  `run_steps` + this gate are plausibly that design arriving. Say so, or say they
  are not. Note the operator-resolution half is currently forbidden by
  `test/shutdown-backup-operator.test.mjs:210-214`.
- **D7 — the `cli-home` mount.** `docs/ROCKY-codebase-audit.md` proposes dropping
  it. The recommended design does not depend on it; any hook fallback would.
- **D8 — pin the Claude CLI.** `Dockerfile.openclaw:19` installs
  `@anthropic-ai/claude-code` unpinned while OpenClaw beside it is pinned and
  asserted (`tenant-openclaw.mjs:362-389`).

## Unverified — resolve before building

The drift analysis read OpenClaw **2026.6.35** locally, not our pinned
**2026.7.1-2**. Two claims rest on it and must be re-checked against the real image:

1. Whether Claude CLI hooks fire at all under `claude -p` headless.
2. Whether our `rocky` MCP server is proxied under `mcp__openclaw__*` rather than
   passed through — which changes any tool-name matcher.

Neither blocks the recommended design, because it does not use hooks. Both block
the fallback.

## Tests

- A step claiming a sent message with no delivery row is **refused**.
- A step claiming a file change with an unchanged hash is **refused**.
- An unverifiable step is **recorded, with its evidence field marking it so**.
- A refusal reaches the model as `isError`, not a transport failure.
- Plan-vs-trace reconciliation flags a step with no supporting tool call.
- **Adversarial:** a step whose payload changed between declaration and completion
  is refused (rule 3).

## Docs in the same PR

- `docs/features/01-inbound-turn.md:61-68,70-81` — the gate, what it verifies, and
  that a mismatch is a refusal rather than a warning.
- `docs/CODEBASE.md` — the verification module.
- `DECISIONS.md` — *Step completion is verified host-side; the hook is not the
  mechanism*, recording both reasons the hook fails and D6/D7/D8.

## Done criteria

- A step that touches the outside world cannot be marked done without evidence.
- Unverifiable steps are recorded as such, explicitly, in code and in docs.
- No verification decision is reachable from inside the container.
- No LLM judge anywhere in the path.
