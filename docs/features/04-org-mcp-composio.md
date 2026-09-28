# 04 — Organization MCP bundle (Composio)

Tools reach the agent through one organization-approved catalogue. A tenant can
connect only what the organization has approved, and each connection is that
tenant's own OAuth account.

## The catalogue

`org/mcp/registry.json` (schemaVersion 2) — six toolkits:

| Toolkit | Auth config |
|---|---|
| Gmail | `ac_VblvLBFF5sk3` |
| Google Calendar | `ac_iIhjOiIsGZKJ` |
| Google Drive | `ac_GZTJ6S_47_IJ` |
| Asana | `ac_qe9r8-cEcmeH` |
| Linear | `ac_lpATDDmFFns3` |
| Fireflies | `ac_nmAJ6PqhaZPp` |

The `authConfigId` is **pinned in the registry**, not discovered at runtime. The
auth config is what determines the OAuth scopes the user is asked for, so
leaving it implicit means the consent screen can change without a code change.
Gmail's broad scopes come from our own auth config, not from a Composio default.

`org/manifest.json` hashes the whole bundle; rebuild only with `tenant org build`.

> `org/policy/tools.json` holds architecture booleans. **No code reads it and it
> contains no read/write rule** — it is not an enforcement point.

## Connect flow

```text
user: "connect calendar"                     (matched on the user's own words)
   │ src/connect.mjs → matchConnectIntent
   ▼
agent MCP tool `connect_account` (or the CLI)          [05]
   │
   ▼
tenant-cli/resources/mcp.mjs → providers/composio/client.mjs
   │ short-lived ES256 assertion identifies Rocky to the sidecar
   ▼
Composio sidecar (FastAPI)  → Composio  → Connect Link URL
   │ scope is a stable acct:<tenantId>; one account per toolkit
   ▼
link sent to the user in WhatsApp; they authorise in a browser
   │
   ▼
GET /connect/composio/callback   (must be OUTSIDE the basic-auth route set)
   │
   ▼
tenant state encrypted in the tenant vault
   │
   ▼
composio-runtime.mjs writes the private endpoint+header projection
   │   → /run/rocky-input/composio.json, mounted read-only
   ▼
invalidateToolState(tenantId)   the next turn states the new tool as connected
```

**Connecting a toolkit costs nothing at runtime** — no container restart, no
reload. Composio's MCP surface is a fixed generic tool-router: the same tool
count before and after a toolkit is added. An earlier design recycled the
container on connect; measured, it changed nothing and was removed.

## Boundaries

- The canonical `openclaw.json` never contains an endpoint or a header. The
  projection is runtime-only, read-only, and regenerated. `composio-runtime.mjs`
  asserts the canonical config is clean.
- Composio credentials live in `platform/runtime-secrets/composio/`, encrypted,
  host-only.
- `src/mcp/openclaw-native.mjs` is a narrow wrapper over OpenClaw's MCP command
  surface. It is not a tool executor.

## How it fails

- **Callback behind basic auth** → the user authorises and lands on a browser
  password prompt. `/connect/*` and `/files/*` are both excluded from the auth
  route set in Caddy.
- **Fireflies uses an API-key scheme**, so the Connect Link flow does not apply
  to it. It is in the catalogue but needs a different path — open item.
- **Sidecar down** → `toolAvailabilityPreamble({ sidecarHealthy: false })` tells
  the agent tools are unavailable rather than letting it claim a tool it cannot
  call.


## Several accounts per toolkit

A tenant may connect more than one account to the same toolkit — two Gmail
mailboxes, for instance. The MCP session is created with
`multi_account={enable: true, require_explicit_selection: true}`, which makes
Composio's tool router expose an `account` argument on every execution and
require it whenever more than one account is connected. The model names an
account by its alias, or by Composio's own handle when no alias is set.

`mcp list` reports one row per account, carrying `account` (the handle) and
`displayName` (the mailbox, where the toolkit publishes one — Gmail and Linear
do; Drive and Calendar do not).

`mcp disconnect --toolkit gmail` removes **every** Gmail account and is refused
once more than one is connected; `--connection ca_...` removes exactly one.

Connecting a second account is a deliberate act, not an error. Only a
half-finished authorization blocks a new Connect Link, because two live links
for one toolkit is a race rather than a choice.

This closes BL-001. See `docs/DECISIONS.md`, 2026-09-25.
