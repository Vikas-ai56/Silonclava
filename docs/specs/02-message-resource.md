# 02 — `message` CLI resource

**Status:** SPEC, not built. **Security-sensitive — second reviewer required.**
**Depends on:** 01 (shares the registry and client change).

## Problem

`send_file_to_user` (`src/agent-mcp.mjs:76-116`) bypasses the resource pipeline the
same way `start_new_session` does, and grew a parallel guard: `needs: ['channel','recipient']`
at `:91` plus a module-level `deliveryContext` at `:125-134`.

Two findings raise the risk above slice 01:

1. **`needs` is dead metadata.** Nothing reads it. Worse, `publicTool()` (`:121-123`)
   strips only `run`, so `needs` is serialised to the model in `tools/list`.
2. **There is no test of this tool at all.** `send_file_to_user` appears nowhere in
   `test/`. Its traversal guard, its `fsp.stat` pre-check and its receipt check are
   unprotected. **Characterisation tests land before the refactor, not with it.**

## The hard constraint

`src/tenant-cli/` is entirely channel-unaware — zero occurrences of `channel` or
`recipient` in the directory. And `bin/tenant.mjs` runs in a **separate process**
where the channel singleton is null and `router.mjs`'s `turnRecipients` map is empty.

`ctx.channel` is a live object captured in a module closure at boot
(`index.mjs:138` → `agent-mcp.mjs:133`). `ctx.recipient` is `lastRecipientFor(tenantId)`
(`router.mjs:61-63`), written only at `router.mjs:385` from the turn envelope.
Neither is serialisable.

## Design — the binding rides on the grant

Rejected: a `configureMessageDelivery()` singleton inside `tenant-cli`. That relocates
the singleton without removing it, and re-creates the parallel mechanism this slice exists
to delete (P1 — the state would still have no owner).

Rejected: re-deriving the recipient from `tenant.phone`. That is a behaviour change —
`turnRecipients` holds the address *this turn arrived on*, which for a multi-alias
tenant need not be `tenant.phone`.

**Chosen:** the grant carries the delivery binding. `authorizeTenantRequest` already
rewrites `request.target` from the grant and never from `params`, so a binding on the
grant is structurally unreachable by the model.

```js
const grant = {
  kind: 'agent',
  tenantId,
  principal: `agent:${tenantId}`,
  delivery: { channel, recipient },
};
```

`createTenantAgentClient` gains a `delivery` argument; `agent-mcp.mjs:194` supplies it
from `deliveryContext` exactly as it does today. The resource reads
`request.authorization.delivery` and **throws if `params` carries any of
`recipient` / `to` / `jid` / `address`** — turning a review property into an enforced one.

`message.mjs` delegates to `deliverWorkspaceFile` (`src/outbox.mjs:87-91`) rather than
re-implementing `agent-mcp.mjs:98-114`. That collapses a third copy of the
`!recipient || typeof channel?.sendMedia !== 'function'` check.

**Registry:**

```js
['message', {
  id: 'message',
  tenantSelfService: false,
  agentActions: new Set(['send']),
  requiresTenant: true,
  terminalActions: new Set([]),
  load: () => import('./resources/message.mjs'),
}],
```

`terminalActions` empty — the precedent is `registry.mjs:126-128`. **`message send` is
refused from the terminal** rather than silently failing on a null channel. This is
open decision **D1**; if the operator should be able to push media, it needs an
explicit transport, not an accidental one.

## Audit

`src/tenant-cli/audit.mjs:5` `SECRET_KEY` does not match `path`, `file` or `caption`,
so they would be logged verbatim. `caption` is model-authored content. Set
`auditParams: { path: relPath }` explicitly and omit the caption — the precedent is
`runtime.mjs:40` (`auditParams: { message: '[REDACTED]' }`).

`SENSITIVE_TEXT` (`audit.mjs:6`) matches `\b[A-Za-z0-9_-]{40,}\b`, which would redact a
signed media URL by accident. Do not rely on that — set `auditResult` explicitly.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-cli/resources/message.mjs` | **new** | — |
| `src/tenant-cli/registry.mjs` | +1 entry | Low |
| `src/tenant-cli/client.mjs:71-87` | `delivery` on the grant, `message()` | **High** |
| `src/tenant-cli/authorization.mjs:52-62` | carry `delivery` through | **High** — security boundary |
| `src/agent-mcp.mjs:76-116`, `:91`, `:125-134` | passthrough; delete `needs` | Medium |
| `src/index.mjs:64`, `:138-141` | `configureAgentDelivery` retained or re-pointed | Medium |
| `src/outbox.mjs:87-91` | reused, unchanged | Low |

`test/tenant-control-plane-boundary.test.mjs:36` forbids `agent-mcp.mjs` importing
`tenant-cli/resources/**` — it must go through `client.mjs`.

## Tests

**Before the refactor** (characterisation, against current behaviour):
- rejects a path escaping the workspace (`resolveWorkspaceFile`)
- rejects a missing file before calling the channel
- throws when the channel cannot send media
- returns `{sent, file, expiresAt}` on success

**After:**
- `message send` rejects a `recipient` / `to` / `jid` / `address` param
- cross-tenant send denied by the grant
- audit line contains the path, not the caption, and no signed URL
- terminal transport refused
- `test/container-mounts-contract.test.mjs`, `test/runtime-hardening.test.mjs:72` still green

## Docs in the same PR

`CODEBASE.md:84`, `:93`, `:100`; `features/05-agent-tools.md:28,36,38-40,56-60`;
`features/06-multimedia.md:70-79`; `DECISIONS.md` — new entry (the existing
`:1552-1582` covers `session` only and explicitly leaves `message` undecided).

## Done criteria

- No module-level delivery singleton reachable from a resource.
- `needs` gone from the tool surface.
- A model-supplied recipient is refused with a tool result, not a crash.
- `npm test` green, including the new characterisation tests.
