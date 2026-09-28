# 07 — Scheduling, cron and hibernation

Containers are expensive to keep and cheap to start. Hibernation buys **memory
and admission**, not latency — `docker start` is ~32 ms; the ~2.3 s a user feels
is OpenClaw's own boot, which happens either way.

## Hibernation

`tenant-gateway.mjs` stops a container after an idle period
(`OPENCLAW_GATEWAY_IDLE_MS`). The idle timer is re-armed **only by user
activity**. Cron execution must never reset it (phase-3C §1.4 — see `DECISIONS.md`) — otherwise
a tenant with a daily job never sleeps.

Liveness is an explicit `inFlight` count, never a timestamp: a slow turn would
otherwise look progressively staler and become the most attractive eviction
victim precisely because it was busy (P5).

Every container instance carries a generation stamp. Work is stamped when it
starts and rejected on completion if the generation moved (P4) — a late reply
from a dead container is otherwise indistinguishable from a live one.

## Cron

```text
OpenClaw's own scheduler (state/openclaw.sqlite)
   │  read ONLY to refresh the mirror; returns null on any failure so an
   │  unreadable source never wipes our schedules (P8)
   ▼
cron-store.mjs           Rocky's authoritative mirror + duration model
   ▼
wake-scheduler.mjs       min-heap of due jobs
   │  • shortest-predicted-first with aging (no starvation)
   │  • 3-slot cron budget (one wake per tenant, carrying every due job)
   │  • overrun preemption
   │  • yieldSlotForInteractive() — a user message stops a cron-only container
   ▼
container wakes, runs the job, POSTs its result
   ▼
POST /internal/cron/delivery        src/cron-ingress.mjs
   │  token-authed; the tenant is resolved from SERVER state, never the payload
   ▼
joins the same persist-then-send path as a user reply        [01]
```

`cron-ingress-listener.mjs` is a dedicated listener bound to the **Docker bridge
gateway**, because the main gateway stays on loopback and a container cannot
reach loopback. (Host→bridge is unroutable on Linux; container→bridge works.
That asymmetry is why the listener exists at all.)

A displaced cron job is not lost: it re-fires on its next wake.

## Logs

Container logs persist to the tenant mount (`tenants/<id>/openclaw/`), bounded
by `OPENCLAW_LOG_MAX_BYTES`. They are how an operator verifies what a tenant's
agent actually did, so they must outlive the container that wrote them (P1).
Claude CLI state and MCP logs persist with the tenant for the same reason.

`readyTiming()` reads `docker logs --since <StartedAt>` and asserts a real
entrypoint duration, rather than reporting a number it never measured.

## How it fails

- **Host saturated** → `MAX_TENANTS_PER_HOST` (5). Interactive traffic evicts
  cron; cron never evicts interactive.
- **Orphan containers after a restart** → reconciled at boot by the gateway.
- **Overrunning job** → preempted against its own predicted duration.


## Creating a job

Until 2026-09-25 nothing could create one: the mirror, duration model, scheduler
and ingress all existed, and zero jobs were ever scheduled. Creation now has two
surfaces, both reaching the same place:

- `tenant cron create --tenant <id> --name <n> --message <m> (--cron|--every|--at) [--tz]`
- the `schedule_job` agent tool, so a user can ask for it in chat

Both wake the container first — OpenClaw's `cron` CLI runs *via its Gateway*, so
`docker exec` into a stopped container cannot work — then exec
`openclaw cron add ... --webhook <ingress> --session isolated --json` and refresh
the mirror from OpenClaw's own table.

Arguments are validated before the exec (`cronAddArgs`) and passed as argv, never
a shell string: the name is restricted to safe characters, exactly one of
`--cron`/`--every`/`--at` is required, and the timezone must look like an IANA
zone. A message is passed through verbatim.

## Several jobs due at the same moment

The wake, not the job, is what the slot budget rations. Every job a tenant has
due inside the lead window rides one container wake. Hibernation is held until
OpenClaw's table shows each of those jobs has advanced past due; if that table
cannot be read the slot is released rather than leaked, with `preemptOverruns()`
as the backstop. Jobs on *different* tenants queue normally and drain against
the 3-slot budget.

See `docs/DECISIONS.md`, 2026-09-25.


## How a result comes back

A job's webhook is `…/internal/cron/delivery?t=<tenantId>`. Both the gateway
route and the Docker-bridge listener take the tenant from that query and pass it
to `handleCronDelivery`; a `tenantId` in the body is ignored, so a container
cannot name another tenant.

OpenClaw posts its own cron event, not a Rocky-shaped body: `jobId`, `runId`,
`summary`, `status`, `runAtMs`, `durationMs`, `job`. The delivered text is
`summary`, and the dedupe key is `jobId:runId` (falling back to
`jobId:runAtMs`), so a recurring job delivers every run while a webhook retry of
the same run does not deliver twice.

Authentication is `Authorization: Bearer <token>`, which OpenClaw sends when
`cron.webhookToken` is set in the tenant's config. Rocky writes that key from
`ROCKY_CRON_WEBHOOK_TOKEN`; with no token configured the ingress denies
everything.
