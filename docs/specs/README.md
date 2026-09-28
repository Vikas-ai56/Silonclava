# Spec suite — 2026-09-22

**Status:** SPEC. Nothing here is built. Grounded against the working tree at
`af57aa8` plus the uncommitted container-contract change.

These are build-time artifacts. Per `docs/README.md`, the durable reference is
`features/` + `DECISIONS.md` + `CODEBASE.md` — each slice lands its docs updates
in the same PR, and these files are deleted once it has.

## Sizing

Large. Five core slices plus one Hermes gap register. The gap register is split
into independently gated changes; it is not one implementation slice.

| Spec | Slice | Risk |
|---|---|---|
| `01-session-resource.md` | `start_new_session` → a `session` CLI resource | Low |
| `02-message-resource.md` | `send_file_to_user` → a `message` CLI resource | **High** — no tests exist today |
| `03-transcript-authorship.md` | Stop rendering platform replies as `You:` | Low |
| `04-mcp-projection.md` | Byte-stable projection, WAKE-phase step | Medium |
| `05-wire-identity.md` | The three `rift` → `rocky` migrations | **High** — irreversible modes |
| `06-hermes-parity-gaps.md` | Only production Hermes capabilities/data not yet carried forward | Mixed — sliced by dependency |

## Sequencing

```
01 ──┐
03 ──┼──> independent, any order
04 ──┘
02 ──────> after 01 (shares the registry + client change), needs new tests first
05 ──────> last, and only 05a/05b; 05c is recommended against
```

`06` follows its own dependency order; do not implement it as one batch.

## Principles these must not weaken

- **P1** — every piece of state has an owner. `deliveryContext` (`agent-mcp.mjs:125-134`)
  is a module-level singleton with no owner; spec 02 must not relocate it unchanged.
- **P8** — don't build guarantees on state you don't own. Constrains spec 05b:
  OpenClaw's `sessions.json` is not ours to rewrite, so a session-key rename has
  no migration, only a cutover.
- **P11** — put an always-true rule where it is always read. Spec 03: the agent
  must learn that the platform authors messages in its thread from the always-read
  guardrail block, not from a conditional branch.
- **P12** — never extend a configuration whose schema you don't own.

## Invariants carried into every spec

1. The model never chooses a recipient (`agent-mcp.mjs:125-129`, `index.mjs:136-137`,
   `router.mjs:54-58`, `DECISIONS.md:886-889`).
2. The agent grant is default-deny: no `agentActions`, no reachability
   (`authorization.mjs:47-51`).
3. The tenant comes from the bearer token, never the payload
   (`cron-ingress-listener.mjs:36-40`).
4. `startNewSession` stays the only writer of `sessionEpoch` (`DECISIONS.md:1578-1581`).
5. A refusal is a tool result, not a transport error (`agent-mcp.mjs:206-207`).
6. Secrets never reach the canonical `openclaw.json` (`tenantHasCanonicalPlaintextMcp`).
7. `src/**` outside `src/tenant-cli/` may not import `tenant-cli/resources/**`
   — enforced by `test/tenant-control-plane-boundary.test.mjs:36`.

## Open decisions for the user

| # | Decision | Where |
|---|---|---|
| D1 | Should `message send` be operator-invocable? Registering it makes `tenant message send --tenant X --path Y` push WhatsApp media from a shell. | 02 |
| D2 | Accept a shorter replay window, or raise `DEFAULT_MAX_CHARS`? A longer label costs budget. | 03 |
| D3 | Accept a one-time conversation reset on every live tenant for the session-key rename? | 05b |
| D4 | Proceed with the Postgres rename against a logged decision not to, and a prior production incident? | 05c |
