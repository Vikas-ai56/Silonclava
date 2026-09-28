# 05 — Agent tools over MCP

The agent needs to do a few things a chat reply cannot: connect an account, tell
the user what is connected, send a file. Rocky serves those itself, as an MCP
server, over a scoped grant.

## Why Rocky is the transport

The tenant CLI already owns every stateful operation, with grants, audit and the
vault behind it. Giving the agent a second path to those operations would mean a
second authorization model. So Rocky exposes the *same* command service as MCP
tools and the grant system decides what the agent may call.

```text
tenant container
   │ mcp.servers.rocky → streamable-http
   ▼
POST /internal/agent/mcp          Bearer <per-tenant agent token>
   │  src/agent-mcp.mjs   (initialize / tools/list / tools/call)
   ▼
resolveTenant(token)  ← the tenant comes from the TOKEN, never the payload
   ▼
createTenantClient({ kind: 'agent', tenantId })
   ▼
tenant-cli/authorization.mjs   default-deny, per-resource action set
```

## The nine tools

| Tool | Does |
|---|---|
| `start_new_session` | Clears the conversation for the next message. [09] |
| `list_connected_accounts` | What this tenant has connected, one row per account. |
| `list_available_toolkits` | What the organization allows. |
| `connection_status` | State of one toolkit. |
| `connect_account` | Starts the Connect Link flow and returns the URL to send. |
| `list_scheduled_jobs` | This tenant's cron jobs, with their ids. [07] |
| `schedule_job` | Creates a cron job from chat. [07] |
| `cancel_scheduled_job` | Removes one by id. [07] |
| `send_file_to_user` | Delivers a workspace file over the channel. [06] |

`schedule_job` is how a user gets a recurring anything by asking for it. The job
is always created with `--webhook` pointed at Rocky's cron ingress and
`--session isolated`, so a scheduled run joins the normal persist-then-send path
and cannot mutate the live chat session.

`configureAgentDelivery({ channel, recipientFor })` supplies the channel **and**
the recipient. The model never names an address — it can only send to the
address the turn is bound to.

## The `agent` grant

Grant kinds: `operator`, `tenant`, `runtime`, `oauth-callback`, **`agent`**.

```js
// tenant-cli/authorization.mjs — default-deny
if (authorization.kind === 'agent') {
  if (!grantedTenant) throw new Error('Agent grant is missing a tenant id');
  if (explicitTarget && explicitTarget !== grantedTenant) throw new Error(/* cross-tenant */);
  if (!definition.agentActions?.has(request.action)) throw new Error(/* not permitted */);
  return { ...request, target: { tenantId: grantedTenant } };
}
```

A resource opts in by declaring `agentActions`. Only `mcp` and `session` do:

```js
agentActions: new Set(['available', 'tools', 'list', 'status', 'connect'])
```

`disconnect` is **deliberately excluded**. So are vault management, tenant
add/remove, tenant-ID routing, user/UID migration, state restore — a resource
with no `agentActions` is unreachable from a model, by construction rather than
by review.

A refused capability comes back as an MCP **tool result** with `isError`, not a
transport error, so the agent can tell the user what it cannot do instead of
failing the turn.

## The credential

Minted once per tenant by `ensureAgentCredential()` [02], stored with the
tenant, reused on every wake, and merged into the container's gateway metadata
on rebuild so a rebuilt container keeps the token it was given.

## `src/agent.mjs` is 49 lines

It does exactly three things: recognise a connect intent, finish a pending
Claude OAuth paste, run the turn. Everything stateful crosses the tenant command
service. If it starts growing again, the new work belongs behind a resource.

## How it fails

- **The agent does not call the tool.** Observed live: asked to send a deck, it
  built the file, printed the container path and said "ready to share". A tool
  being advertised is not enough — the always-on audience rule states that the
  user has no filesystem. This reduces the failure; it does not eliminate it.
  There is no silent-failure mode: the user notices a missing file immediately.
- **Token mismatch** → 401 at the transport. The tenant is never read from the
  request body.
