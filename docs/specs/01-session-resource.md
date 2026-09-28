# 01 — `session` CLI resource

**Status:** SPEC, not built. Security-sensitive (adds an agent-reachable action).
**Decision log:** `DECISIONS.md:1552-1582` already records this decision.

## Problem

`start_new_session` (`src/agent-mcp.mjs:22-34`) calls `startNewSession(ctx.tenantId)`
directly at `:31`. It is the only agent capability with no resource definition, so
`authorizeTenantRequest` never sees it: no grant gate, no audit line. The comment at
`agent-mcp.mjs:18-19` — "the scope here cannot exceed what `agentActions` permits" —
is currently false for this tool.

## Design

`startNewSession` stays in `src/tenant-session.mjs`. A new resource calls it.
Moving the function would break `test/workspace-guardrails.test.mjs:447-453`, which
greps that file for `sessionFromSequence: fromSequence`.

**New file** `src/tenant-cli/resources/session.mjs`:

```js
export async function handleResourceAction(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

  if (request.action === 'new') {
    const { epoch, fromSequence } = await startNewSession(tenant.id);
    return { tenantId: tenant.id, mutating: true, result: { started: true, session: epoch, fromSequence } };
  }
  if (request.action === 'show') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: { session: Number(tenant.sessionEpoch || 0), fromSequence: Number(tenant.sessionFromSequence || 0) },
    };
  }
  throw new Error(`Unsupported session action: ${request.action || '<empty>'}`);
}
```

**Registry** (`src/tenant-cli/registry.mjs`, after the `runtime` entry):

```js
['session', {
  id: 'session',
  tenantSelfService: false,
  agentActions: new Set(['new', 'show']),
  requiresTenant: true,
  load: () => import('./resources/session.mjs'),
}],
```

`requiresTenant: true` because there is no tenant-less session action — unlike `mcp`,
which is `false` for `configure` / `sync --all`.

**Client** (`src/tenant-cli/client.mjs`): add `session()` to `createTenantAgentClient`
(`:71-87`) and `createTenantClient` (`:15-63`). The frozen agent client currently
exposes only `mcp()`.

**MCP tool** becomes a passthrough, keeping its exact name and description — both are
asserted by `test/workspace-guardrails.test.mjs:138-145` and referenced from
`org/templates/workspace/AGENTS.md:56`, which is inside the hashed `GUARDRAIL_VERSION`
block:

```js
run: async (client) => (await client.session().new()).result,
```

Delete the `startNewSession` import at `agent-mcp.mjs:4`.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-cli/resources/session.mjs` | **new** | — |
| `src/tenant-cli/registry.mjs` | +1 entry | Low |
| `src/tenant-cli/client.mjs:71-87`, `:15-63` | +`session()` | Low |
| `src/agent-mcp.mjs:4`, `:22-34` | passthrough | Low |
| `src/tenant-session.mjs` | none | — |
| `src/tenant-cli/authorization.mjs` | none — the point of the change | — |

## Docs in the same PR

- `CODEBASE.md:84` — says "the five `AGENT_TOOLS`"; there are six. Fix and add the resource.
- `CODEBASE.md:93` — "only `mcp` has any [`agentActions`]" becomes false.
- `CODEBASE.md:100` — operator-only resource roster.
- `features/05-agent-tools.md:28` "## The five tools", `:56-60` "Only `mcp` does".
- `features/09-workspace-and-session.md:93-95`.
- `DECISIONS.md:1552-1582` — extend with the `show` action and `requiresTenant: true`.

## Tests

| Test | Action |
|---|---|
| `test/agent-scope.test.mjs:31-44` | extend: `session new` allowed for agent grant |
| `test/agent-scope.test.mjs:57-65` | extend: `session delete` (nonexistent) denied |
| `test/tenant-cli.test.mjs:20-56` | add: `session new` writes an audit line |
| new | epoch increments by exactly 1; `sessionFromSequence` recorded |
| `test/workspace-guardrails.test.mjs:138-145` | must still pass unchanged |
| `test/tenant-control-plane-boundary.test.mjs:36` | must still pass — go via `client.mjs` |

## Done criteria

- `./bin/tenant.mjs session show --tenant <id>` works under the operator grant.
- An agent `session/new` call appears in `tenants/<id>/audit.jsonl` as `agent:<id>`.
- An agent call to any unlisted `session` action is refused by `authorization.mjs:58`.
- `npm test` green.
