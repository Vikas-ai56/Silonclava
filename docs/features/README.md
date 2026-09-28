# Features

One doc per capability. Each answers the same four questions: **what it does**,
**the flow**, **where the boundary is**, and **how it fails**.

| # | Feature | One line |
|---|---|---|
| [01](01-inbound-turn.md) | Inbound turn | WhatsApp message → queue → container → committed reply. The spine. |
| [02](02-tenant-isolation.md) | Tenant isolation | One container, one mount set, one vault per tenant. |
| [03](03-persistence-and-context.md) | Persistence & context | Encrypted transcript, turn ledger, keyword search, prompt preambles. |
| [04](04-org-mcp-composio.md) | Org MCP bundle | Six approved toolkits, Composio auth, per-tenant projection. |
| [05](05-agent-tools.md) | Agent tools over MCP | Rocky as an MCP server; the `agent` grant on the tenant CLI. |
| [06](06-multimedia.md) | Multimedia | Inbound fetch, voice transcription, outbound signed links. |
| [07](07-scheduling-and-hibernation.md) | Scheduling & hibernation | Cron wakes, slot budget, idle stop, interactive preemption. |
| [08](08-deploy-and-operations.md) | Deploy & operations | Prod topology, push, logs, backups, gates. |
| [09](09-workspace-and-session.md) | Workspace & sessions | Managed guardrails, activation, session identity, persona skill. |
| [10](10-admission-and-eviction.md) | Admission & eviction | Capacity policy: overdue-scored eviction, bounded wait, cron yields to people. |

## System map

```text
        WhatsApp (Twilio)
               │  POST /webhooks/twilio/inbound     (signature-checked)
               ▼
        ┌──────────────────────────────────────────────────────┐
        │ Rocky gateway (host process, Node)                    │
        │                                                      │
        │  channels/  → router → inbound-queue ─┐              │
        │                 │                     │ per-tenant   │
        │                 │                     │ FIFO lane    │
        │   tenant-data/ (SQLite, AEAD)   ◄─────┘              │
        │   media-host  /files/<signed>                        │
        │   agent-mcp   /internal/agent/mcp                    │
        │   cron-ingress (docker bridge listener)              │
        └───────┬──────────────────────────────────────────────┘
                │ docker exec / HTTP on loopback
                ▼
        ┌──────────────────────┐        ┌───────────────────────┐
        │ tenant container      │  MCP   │ Composio sidecar      │
        │ OpenClaw + Claude CLI │◄──────►│ (FastAPI, ES256 auth) │
        │ whisper.cpp           │        └───────────────────────┘
        │ mounts: workspace,    │
        │ openclaw, cli-home    │  ← never the vault, never the tenant root
        └──────────────────────┘
```

The three rules the whole design rests on:

1. **The tenant boundary is the mount set.** A container sees its own
   workspace, its own OpenClaw state, its own CLI home. Nothing else.
2. **Nothing irreversible happens before it is written down.** The reply is
   committed to the ledger, then sent (P2).
3. **The transcript is the agent's memory**, not OpenClaw's session. Containers
   are disposable; the record is not (P1).
