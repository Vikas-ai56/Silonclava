# 04 — Byte-stable MCP projection

**Status:** SPEC, not built.
**Decision log:** `DECISIONS.md:1583-1607` exists; **its risk bullet `:1599-1605` is
now stale** (the `rift-input`/`rocky-input` mismatch was fixed this session and is
regression-tested at `test/image-contract.test.mjs:19-28`). Correct it in this PR.

## Problem, restated after drift analysis

The original framing — "rewritten on every bring-up" — was too generous. The drift
trace found three separate causes, in increasing severity:

**1. It is rewritten on every turn, not every bring-up.**
`resolveOpenclawRunContext` (`tenant-openclaw.mjs:589`) calls `hydrateMcp` and is
invoked from `runOpenclawTurn:775` — i.e. per user message. The WAKE step
`'mcp projection present'` (`tenant-onboarding.mjs:53-59`, `required: false`) is
therefore almost always a no-op returning `'present'`, because the turn path already
rewrote the file. **Promoting projection preparation into WAKE without reframing the
call at `tenant-openclaw.mjs:589` creates two preparation sites, not one.**

**2. `fs.rm` + `fs.writeFile` always allocate a new inode.**
`composio-runtime.mjs:58,74`. A running container's bind mount holds the *old*,
now-deleted inode. Byte-equality does not fix this — only *not writing* preserves the
inode. This is the core of the change.

**3. `detectBridgeGateway()` is uncached and can drop a server entirely.**
`cron-ingress-listener.mjs:12-23` shells out to `docker network inspect bridge` on
**every** call and returns `null` on any failure. `composio-runtime.mjs:44-48` then
warns and returns `null`, and `:71` only adds `rocky` when truthy — so a transient
docker-CLI hiccup silently removes the entire `rocky` MCP server from the map, and it
reappears on the next turn. That is a *membership* change, strictly worse than a byte
change, and it is intermittent by construction.

## Design

**Derive, compare, write only on change.**

```js
const next = `${JSON.stringify({ servers })}\n`;
const current = await fs.readFile(projectionPath, 'utf8').catch(() => null);
if (current !== next) await atomicWrite(projectionPath, next);
await fs.chmod(projectionPath, 0o600);
```

The `chmod` runs unconditionally. `mode:` on `writeFile` is umask-masked at create and
a no-op on an existing file, so an early return that skipped it would never repair a
pre-existing `0644`.

Drop the unconditional `fs.rm(directory, {recursive: true})` at `:58`. It must still
run when `rawEndpoint` is falsy — that path is the legitimate teardown.

**Fail closed on a missing bridge.** `rockyAgentServer` returning `null` must become an
error, not a warning. A projection without `rocky` is not a degraded projection, it is
a different capability set. Better to refuse the turn than to silently strip the
agent's control-plane tools and reset the conversation.

**Memoise `detectBridgeGateway`.** The bridge address does not change while the daemon
runs. Cache the first successful answer for the process lifetime.

**One preparation site.** Projection preparation belongs to bring-up, not to the turn.
Remove the `hydrateMcp` call from `resolveOpenclawRunContext` and make the WAKE step
`required: true`. Ordering is fixed by two existing tests:
- after `'agent credential'` — the projection embeds `meta.agentToken`
- before `'bind-mount sources still exist'` — `test/runtime-hardening.test.mjs:19-28`
- **not** on CREATE — `test/runtime-hardening.test.mjs:30-32`; `tenantMountSpec`
  decides the bind from `fs.existsSync`, and on CREATE the file does not exist yet

**Hash in gateway meta.** Store `mcpServersHash` in `.rocky-gw.json`, compare on wake,
log which server changed. The writer **must** read-then-spread: `docker-gateway.mjs:74-78`
does a whole-file write with no internal merge, and a wholesale write here is exactly
what once re-minted `agentToken` on every rebuild (`DECISIONS.md:827-832`).

Note `.rocky-gw.json` lives under `tenants/<id>/openclaw/`, which is bind-mounted
**read-write** into the container (`docker-gateway.mjs:285`). The hash is a cache key,
not an integrity check — do not let anything trust it for security.

## What remains an unavoidable reset

`sync` calls `client.resolve()` → `composio_gateway.py:252-280` → `sessions.create(...)`,
a **new Composio session per call**, so the tool-router URL is expected to rotate.
`sync --pending-only` runs on **every turn** from `agent.mjs:48`; its guard
(`resources/mcp.mjs:75-77`) skips only when a record exists, `endpoint` is truthy, and
no connection is `INITIALIZING`/`INITIATED`. **A tenant with a pending connect therefore
gets a new tool-router URL on every turn, and a session reset with it.** That is
inherent to Composio's API, not to our code. It must be logged as a known cause and not
re-diagnosed — `DECISIONS.md:1606-1607` already says so.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/mcp/composio-runtime.mjs:56-97` | compare-then-write; fail closed on null bridge | Medium |
| `src/cron-ingress-listener.mjs:12-23` | memoise | Low |
| `src/openclaw/tenant-openclaw.mjs:589` | remove per-turn hydration | **High** |
| `src/openclaw/tenant-onboarding.mjs:53-59` | `required: true` | Medium |
| `src/openclaw/docker-gateway.mjs:74-78` | `mcpServersHash`, merged | Medium |

## Tests

| Test | Action |
|---|---|
| new | two consecutive prepares leave the file's **inode and mtime** unchanged |
| new | a changed endpoint writes, and logs which server changed |
| new | a null bridge throws rather than emitting a projection without `rocky` |
| new | `chmod` repairs a pre-existing `0644` even when bytes match |
| `test/runtime-hardening.test.mjs:19-32` | ordering must still hold with `required: true` |
| `test/container-mounts-contract.test.mjs:14-26` | exactly 4 mounts for a projection-less tenant |
| `test/mcp-config.test.mjs:211-228` | hydrate round-trip unchanged |
| `test/composio-docker-runtime-smoke.test.mjs` | real-container validate still passes |

## Docs in the same PR

`features/04-org-mcp-composio.md:67-69` — the word **"regenerated"** is precisely what
this change inverts; `features/07-scheduling-and-hibernation.md` — currently silent on
the projection being deleted at hibernation and rehydrated on wake (a gap);
`features/02-tenant-isolation.md:56-57` — the step list omits `workspace guardrails`
and `mcp projection present` and is already drifted; `CODEBASE.md:112`;
`DECISIONS.md:1583-1607` — correct the stale bullet and add the three causes above.

## Verification note

`resolveCliSessionReuse` and `normalizeOpenClawLoopbackUrl` are not in this repo — the
drift tracer correctly could not find them. They were read directly from the running
image at `/usr/local/lib/node_modules/openclaw/dist/cli-session-Brkq2YyO.js`, and the
30 `invalidated:mcp` events were read from
`tenants/br_f253fafe2f46/openclaw/logs/gateway.log` on the deployment host. The claim
is measured, not inferred, but it is not reproducible from this checkout.

## Done criteria

- Two consecutive prepares with unchanged state perform **zero writes**.
- Exactly one projection preparation site.
- A missing bridge address fails the turn loudly.
- `npm test` green.
