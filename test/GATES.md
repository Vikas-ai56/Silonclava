# Live migration gates

The `*-contract.test.mjs` files validate configuration and command construction.
They do **not** prove live Claude refresh, Docker isolation, MCP bridging, or
session continuity. Do not describe a green `npm test` run as passing Gate A or
Gate B.

Before routing a tenant to OpenClaw, run these gates with a disposable tenant
credential and the pinned image (the version is defined once in
`src/config.mjs` as `OPENCLAW_VERSION`; currently `2026.7.1-2`):

1. Confirm the container process has no `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` in its environment or
   Claude `settings.json`.
2. Hand-expire `claudeAiOauth.expiresAt`, perform a real turn, and verify Claude
   rewrites the bind-mounted `.credentials.json` with a new access token.
3. Restart, remove, and recreate the tenant container; verify authentication,
   the OpenClaw session, and the Claude project transcript all resume.
4. Start two tenant containers. From each, prove the other tenant's workspace,
   OpenClaw state, Claude home, route, and vault are inaccessible. Prove `/org`
   is read-only.
5. Register a harmless tenant MCP tool and prove the complete path:
   tenant MCP -> OpenClaw bundle bridge -> `mcp__openclaw__<tool>` -> real
   Claude CLI call.

Record the exact image digest, Claude CLI version, disposable tenant IDs, and
pass/fail evidence. Never use a production tenant credential for these gates.

## Phase 3C gates

Some of these now run in `npm test` because Docker is available; the rest need a
live Claude credential and are still manual. **A green `npm test` proves the
automated ones only.**

| Gate | Automated? | Where |
|---|---|---|
| Pinned image boots a gateway to ready | yes | `openclaw-gateway-boot.test.mjs` |
| Image ships every `@openclaw/*` package it declares | yes | `openclaw-gateway-boot.test.mjs` |
| Container hardening in effect (caps zeroed, NoNewPrivs, non-root, pids) | yes | `container-hardening.test.mjs` |
| Two hardened tenants isolated; several run concurrently | yes | `container-hardening.test.mjs` |
| Generated config passes `openclaw config validate` | yes | `composio-docker-runtime-smoke.test.mjs` |
| Persist-before-send: delivered bytes equal committed bytes | yes | `persist-before-send.test.mjs` |
| Duplicate/out-of-order delivery callbacks are idempotent | yes | `persist-before-send.test.mjs` |
| Cron ingress auth, idempotency, recipient binding | yes | `cron-ingress.test.mjs` |
| Wake scheduling, slot budget, preemption, P8 independence | yes | `wake-scheduler.test.mjs` |
| Docker cold start: stop/remove/recreate, all four roots intact | yes | `step7-live-gates.test.mjs` |
| Isolation: vault and data never mounted; `/org` read-only in practice | yes | `step7-live-gates.test.mjs` |
| Privacy: no plaintext in raw database bytes | yes | `step7-live-gates.test.mjs` |
| Crash window: re-execute pre-commit, never re-run a committed turn | yes | `step7-live-gates.test.mjs` |
| Backup → staged restore → cold open with content intact | yes | `step7-live-gates.test.mjs` |
| Shutdown ordering and classification | yes | `shutdown-backup-operator.test.mjs` |
| End-to-end: message in → committed → delivered bytes | yes (model stubbed) | `end-to-end-flow.test.mjs` |
| **Live model turn with a real Claude credential** | **no** | needs a disposable tenant credential |
| **Hibernate → wake → cron fires → delivered, end to end** | **no** | needs a live model turn |
| **Twilio signature against real webhook traffic** | **no** | needs the public URL, currently serving Hermes |
| **Off-host encrypted backup transfer** | **no** | §8 requires an off-host target; only local verified snapshots are implemented |

### Still manual before Phase 4

The four rows marked **no** above are the remaining Phase 3C gates. The first two
need a disposable tenant Claude credential; the third needs the Twilio webhook
pointed at this service instead of Hermes; the fourth needs an off-host backup
target to be chosen. Do not describe Phase 3C as gated-complete until they are
run and their evidence recorded here.

## Phase 3 native OAuth preflight

On 2026-09-17, pinned OpenClaw `2026.7.1-2` (the prerelease pin in use at the
time; now `2026.7.33`) successfully persisted and listed
an `mcp.servers` entry in the container. Native login against Google's official
Gmail MCP endpoint stopped before authorization with:

```text
Incompatible auth server: does not support dynamic client registration
```

The pinned schema exposes `scope`, `redirectUrl`, and `clientMetadataUrl`, but
not a static OAuth client id/secret. Google Workspace and Asana V2 require
configured/pre-registered client credentials, so both remain fail-closed in
the org registry. Do not satisfy Gate 5 with the legacy Google vault or a
custom token exchange. Use a harmless non-OAuth MCP for the bridge gate, and
keep provider OAuth blocked until OpenClaw exposes a native safe configuration.


## Phase 3C regression evidence (2026-09-18)

| Check | Result |
|---|---|
| Three consecutive full runs | 270/270 each, identical — no flakiness |
| All 59 test files run **standalone** | every file clean — no order dependence or shared state |
| `ROCKY_OPENCLAW_PACKAGE_DIR` unset | 269 pass, 1 skip — capability gate degrades, does not fail |
| `ROCKY_OPENCLAW_IMAGE` pointed at a missing image | 261 pass, 9 skip — every Docker gate skips gracefully |
| Clean-slate `ROCKY_TENANTS_DIR` / `ROCKY_PLATFORM_DIR` | 270/270 — nothing inherited from prior state |
| Writes to the real `tenants/` or `platform/` | none |
| Containers or suite temp roots left behind | none |
| Org bundle after the full regression | `ok: true` |

**One real defect found by this regression:** `openclaw-pin-consistency.test.mjs`
asserted the *effective* image always equals `rocky-openclaw:${OPENCLAW_VERSION}`.
`ROCKY_OPENCLAW_IMAGE` exists so a deployment can point at its own registry, so
that assertion would have failed any such deployment. Fixed to check the derived
default only when no override is set.
