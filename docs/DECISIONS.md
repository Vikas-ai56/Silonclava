# Migration decisions — current through Phase 3B

**Purpose:** compact, current decision log for a new coding session. This
consolidates migration decisions only; historical Hermes operational decisions
remain in `../hermes-agent/docs/decisions.md`.

**Authority order:** this file → `SPEC-phase3b-composio.md` →
`SPEC-phase3-mcp-org-connectors.md` / `SPEC-phase2b-tenant-control-plane.md`.
`PLAN.md` is historical and must not be used to restore removed paths.

| Area | Current decision | Supersedes / consequence |
|---|---|---|
| Tenant unit | One end user = one isolated tenant. An enterprise can have one or many tenants. | No shared user workspace, session, vault, CLI home, or OpenClaw state. |
| Tenant identity | Use opaque `br_<random>` UIDs with atomic phone/JID index claims. | Do not use phone-named directories as routing authority or fallback. |
| Model | OpenClaw native `claude-cli` is the only target model path. Each user connects their own Enterprise/Teams Claude subscription. | No Anthropic Console API key; never combine Claude CLI with the retired custom AI runtime. |
| Claude credentials | Official Claude CLI owns tenant credentials in `tenants/<uid>/cli-home/claude`. | Static Anthropic/OAuth environment credentials are scrubbed because they outrank refreshable CLI credentials. |
| Context | Claude Code owns compaction; durable OpenClaw/Claude state stays on the host. | No custom/OpenClaw compactor. Canonical long-term channel transcript is **not implemented** until Phase 3C. |
| Runtime shape | One OpenClaw container per tenant, **hibernated when the user is idle**. The pool is an elastic cache again, bounded by warm slots. | **Reverses the always-on decision, 2026-09-18.** Always-on was adopted because OpenClaw's scheduler runs inside the Gateway, so an evicted container stops firing cron. That reasoning was incomplete: the host does not need OpenClaw's scheduler running to know when a job is due — it can read the next run time and wake the container in time. Always-on costs 213 MiB per tenant with no elasticity, which does not fit a fixed 4 GB VM with a growing tenant count. Hibernation preserves one-OpenClaw-per-user exactly; it changes only *when* an instance runs, never *whose* it is. |
| Container supervision | The host owns restart; keep `--restart no`. | Docker auto-restart would bypass the host's generation counter and break stale-generation rejection. |
| Container config freshness | `recycleTenantGateway` means stop → confirm exited → **start now** → bump generation. Every config-mutating CLI action triggers it. | The entrypoint builds effective config into tmpfs **at container start only**, so a long-lived warm container may run for a long time without re-reading config, giving `tenant mcp disconnect` and org-registry changes unbounded revocation latency. Hibernation shortens but does not bound this, since a busy tenant may stay warm indefinitely. |
| Cron transcript scope | The canonical transcript covers **user-initiated turns only**. Scheduled output is delivered but not ledgered. | Cron turns originate inside the container, so they are absent from `turns`/`messages`, uncounted by `inFlight`, outside the shutdown drain, and bypass persist-before-send. Stated explicitly rather than left as an implied gap. Revisit if scheduling moves host-side. |
| Tenant database | `better-sqlite3@^13.0.3`. One `openTenantDb()` factory applies every pragma and asserts `synchronous === 2`; bare `new Database()` is banned. Backups run on the writer's own connection. | `synchronous` does not persist in the file and better-sqlite3 compiles `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so any connection that omits the pragma silently commits at NORMAL. A backup from a second connection never converges (measured: 202,155 restarts). Requires glibc ≥ 2.34 and Node ≥ 22.14. |
| Backup ownership | OpenClaw's databases are backed up with `openclaw backup create --verify`; Rocky's with `db.backup()`. Never raw-archive `openclaw/`. | `openclaw/` holds two live WAL databases belonging to a container that is never stopped. A filesystem copy of a live WAL database loses recent commits and still opens clean. |
| Missed cron | Upstream defaults are correct and are left alone. **No `cron` options are set in generated config.** Verified against the pinned image 2026-09-18: a missed cron job fires **once** on restart regardless of outage length, because eligibility compares only the single most recent slot (`previousRunAtMs > lastRunAtMs`). Model-backed (`agentTurn`) jobs are deferred 2 min at startup (`deferAgentTurnJobs: true`); non-agent jobs are capped at 5 immediate with a 5s stagger. | **Corrected twice.** The original "OpenClaw reschedules rather than replays" was wrong; the replacement (`cron.skipMissedJobs: true`) was worse — that key does not exist in `openclaw@2026.7.1-2`, the schema is strict, so it made `openclaw config validate` fail and **every tenant container refused to start**. It is also semantically backwards: it *drops* missed runs, whereas a crash-window run must still fire. `skipMissedJobs` first appears in 2026.9.1. The catch-up knobs (`maxMissedJobsPerRestart`, `missedJobStaggerMs`, `startupDeferredMissedAgentJobDelayMs`) are internal and not configurable. |
| Turn recovery | A failed turn is **re-executed in full**: the original user request is resubmitted and the model calls every tool again from scratch. No replay of recorded steps, no partial continuation, no resumption. | Safe **only because the tool surface is enforced read-only in code** (see next row). Removes the `uncertain` state and `tenant turn resolve`. The database needs only the inbound message(s) and the committed response — no tool-call ledger for recovery. |
| Tool surface | **Full read/write/delete on every enabled toolkit** via an explicit `access: "full"` in the org registry. A toolkit must declare either `access: "full"` or a read-only `toolFilter.include`; declaring neither fails closed, and declaring both is an error. | **Changed 2026-09-18 at the operator's explicit direction**, superseding the read-only surface set earlier the same day. Full access can never be acquired by *omitting* a filter — it must be stated. Confirmation before consequential actions is instructed in `org/templates/workspace/TOOLS.md` ("Confirm consequential, write, or destructive actions before executing them"). **That is UX, not enforcement**: a prompt instruction can be argued out of, so it is not a security control. |
| Write-tool gate | **Triggered.** With writes enabled, total re-execution is disabled: an interrupted turn is marked `failed` with `UNCERTAIN_WRITE` instead of being requeued, and surfaces in `tenant turn list`. | SPEC-phase3c §6 says re-execution is valid *only* while every reachable action is read-only — a re-run could repeat a send, create, or delete. The guard is `writesEnabled()` on the org registry, applied at boot and at every recovery. **This is a stop-gap, not the specified design.** §6 requires either per-tool idempotency keys or the `uncertain` state plus an operator resolution path; neither exists. Today an interrupted write-capable turn simply does not complete and needs human attention. |
| Operator mutations | Writes come from the gateway process only. `bin/tenant.mjs` and other operator processes get a **readonly** handle from `openTenantDb()`, enforced by SQLite itself (`SQLITE_READONLY`), not by convention. Operator *mutations* go through the gateway. | Decided 2026-09-18. A single-writer contract can be relaxed later; admitting a second writer now would permanently bind backup convergence, WAL checkpointing, and the fencing generation to a two-writer world. Operator reads and backups are unaffected. |
| Transcript AEAD | The AES-GCM primitive lives in `src/privacy/aead.mjs`; `src/tenant-cli/storage/vault-crypto.mjs` is a thin re-export that keeps the vault's public API unchanged. | Resolves a real conflict: §4/§7 require production code to encrypt transcripts, while `test/tenant-control-plane-boundary.test.mjs` forbids production code importing `tenant-cli/storage/**`. One implementation, not two. Derivation context, envelope shape, and version are byte-for-byte unchanged, so existing vault records still decrypt — no data migration. |
| `new Database()` ban | Enforced by `test/tenant-data-store.test.mjs`, not by lint. | SPEC §4 says "banned by lint", but the repo has no lint toolchain — the only eslint dependency is a vendored no-op stub satisfying a Baileys peer requirement. A test runs on every `npm test`; a lint that does not exist enforces nothing. Standing spec deviation, recorded rather than silently skipped. |
| Payment-card detection | Luhn **plus** a real issuer prefix **plus** either card-style grouping or nearby card vocabulary. | Luhn alone matches roughly one in ten 16-digit figures. §7 makes a policy hit *block the message*, not redact it, so a false positive drops a legitimate user message — unacceptable at a firm where large figures appear in ordinary prose. Caught by a test asserting a Luhn-valid 16-digit deal size is allowed. |
| Schema recovery scope | A corrupt or unreadable database is quarantined (never deleted) and replaced with an empty schema. A *schema* disagreement — checksum mismatch, unknown version, wrong tenant id — is never auto-recovered. | Corruption is an environment fault where serving matters more than the lost rows. A schema disagreement is a code or routing bug where discarding data destroys the evidence needed to diagnose it. Wrong-tenant is additionally a cross-tenant exposure and always hard-fails. |
| Queue lane key | Lanes are keyed on resolved `tenant.id`. Resolution (allow-list, then find-or-claim) happens in the router **before** the enqueue. | Decided 2026-09-18 (§10 step 2). The previous key was the sender's phone digits, so one tenant reached through a phone JID and a LID could open two lanes and run two concurrent turns. A non-allow-listed sender is now dropped before any tenant row or transcript row exists. |
| Coalescing | Coalescing is a property of the database, not of a timer: an inbound message arriving while the conversation's turn is still `queued` is attached to that turn. A `running` turn is never joined. | Each source message keeps its own ordered `messages` row, so nothing is lost to coalescing. Unlike the in-memory buffer it replaces, a burst spanning a restart still merges correctly, and the coalesce window is no longer a race against process death. |
| Turn claim | `claimNextTurn` is a single transaction that refuses to claim while any turn is `running`, enforcing one active turn per tenant at the database rather than in a boolean. | A crashed process leaves state in the database, not in a lost `busy` flag. Restart recovery returns `running` turns to `queued`; `attempt` increments so re-execution is visible. |
| Boot recovery scope | Recovery skips tenants with no existing database file. | `openTenantStore` creates the database, so recovering every listed tenant would make boot the thing that brings 27 empty ledgers into existence. Covered by a test. |
| Cron response delivery | A cron result is an ordinary **outbound AI response**: it is persisted to `messages` and enters the turn state machine directly at `response_saved`, then follows the same send path as a user reply. One thin loopback ingress receives it; there is no second delivery track. | Decided 2026-09-18. Discovered that cron output currently has **no delivery path at all**: Rocky strips every WhatsApp channel from the tenant config (it owns the channel), so OpenClaw's default `delivery.channel: "last"` resolves to nothing and fails with *"Channel is required when delivery.channel=last has no previous channel."* Supersedes §1.4b's claim that scheduled output *is* delivered. Converging on the shared path also brings cron output inside the §7 privacy guard and the delivery ledger. |
| OpenClaw pin | `OPENCLAW_VERSION` in `src/config.mjs` is the only place the version is written; Dockerfile ARG and the build script are held to it by a test. Pinned to **2026.7.1-2**, confirmed 2026-09-24 as the intended pin. *Corrected 2026-09-24: this row previously claimed 2026.7.33. That bump was written down but never landed — `src/config.mjs:102` and `Dockerfile.openclaw:9` have both read `2026.7.1-2` throughout. The artifact was always the truth; the log was wrong.* | Bumped 2026-09-18. The previous pin `2026.7.1-2` was a semver *prerelease* — the hyphen sorts it before `2026.7.1`. The version had been duplicated across ten files, which is how an unvalidated cron option reached four documents and the code. Stay off 2026.9.x while npm tags `latest` and `beta` at the same version. All five claude-cli capabilities re-verified against 2026.7.33. |
| Host capacity ceiling | `MAX_TENANTS_PER_HOST` (was `MAX_WARM`) is checked **at provisioning** and refuses to onboard a further tenant. It never stops a running one. `ROCKY_OPENCLAW_MAX_WARM` still reads through. | Renamed 2026-09-18: with always-on containers it is no longer a warm-cache size but the host's capacity ceiling — each container reserves 2g, so N tenants commit 2N GB whether or not anyone is talking to them. Removing it entirely would let the box oversubscribe until the OOM killer picks a victim, and the victim's cron dies with it. It was also being enforced only at container start, so a tenant could be onboarded and only fail later. |
| Persistence layer | Raw `better-sqlite3` behind a repository module (`src/tenant-data/**`), not an ORM. No `.prepare()` may appear outside it, asserted by a test. | Bound parameters give the same injection safety an ORM would. The deciding factor is that §4 forbids any network/model/Docker/encryption call inside a transaction, and a synchronous driver makes that *structurally impossible* — an async-first ORM would make the worst failure mode easy to write and invisible in review. Also: `openTenantDb()` must own pragma setup (the thing an ORM would abstract), there is one database per tenant, and `db.backup()` on the writer connection is a raw API §4 requires. |
| Runtime isolation (final) | **One OpenClaw instance per user, always — not negotiable.** Multi-tenant-per-process is rejected permanently. | Decided 2026-09-18 after measuring the alternative. One process with 16 agents costs 228 MiB vs ~3,408 MiB for 16 containers (a 15× saving), and it boots, but every agent shares one `$HOME` and therefore one Claude credential: the Anthropic backend strips `CLAUDE_CONFIG_DIR` via `CLAUDE_CLI_CLEAR_ENV` and launches with `--setting-sources user`. That breaks per-user Enterprise seats and is a cross-tenant exposure. Memory pressure is not a sufficient reason to spend the isolation boundary. Note also that *multiple OpenClaw processes in one container saves nothing*: memory is per Node process (~213 MiB each, ~1 MiB container overhead). |
| Warm slots | **5 warm containers maximum; cron may occupy at most 3.** At least 2 slots are therefore always available to interactive traffic. | Set 2026-09-18. 5 × 213 MiB ≈ 1.07 GB, which fits a 4 GB VM alongside the OS and the Rocky host process. The cron sub-cap keeps preemption rare: with headroom permanently reserved, an inbound user message almost never waits for a stop/start round-trip (~4.4 s measured). Capacity is bounded by *concurrent* tenants, not *registered* tenants. |
| Preemption | Interactive work always outranks cron. At capacity, an inbound user message preempts a cron-only container. A container with an interactive turn in flight is **never** preempted. A due cron wake at capacity is queued, not forced. A preempted cron job is **not** marked failed. | Decided 2026-09-18 on the stated ground that cron output is not time-sensitive while user messages are. Preempting cron is safe rather than lossy: a job whose container is stopped re-fires once on next wake, measured against the pinned image. Marking it failed would be factually wrong and would fire failure alerts. `inFlight` (§3) is the signal that protects an in-progress user turn. Victim order: fully idle first, then longest-since-*user*-interaction. |
| Definition of idle | Idle means **no explicit user request**. Scheduled job execution never resets the idle timer. | Carried over from `BL-004` and confirmed by the user. A tenant whose cron runs nightly but who has not messaged in three months is idle and is hibernated. Without this rule cron alone would keep every container resident and hibernation would reclaim nothing. |
| Cron schedule source | Rocky keeps **its own mirror** of each tenant's cron schedule in the tenant database. OpenClaw's `state/openclaw.sqlite` is read only to refresh that mirror while the container is warm, never as the authority. | `PATTERNS.md` P8: a dependency's internal state is not an API. Wake scheduling is a guarantee we make, so it must rest on a table we own. Verified 2026-09-18 that `cron_jobs.next_run_at_ms` is readable from the host bind mount while the container is stopped — which is what makes wake-before-due possible at all — but reading it as the source of truth would let an OpenClaw upgrade silently stop every tenant's cron with no error. A stale mirror still wakes containers; a vanished schema does not. |
| Container runtime | Docker is retained. `systemd-nspawn` and per-tenant microVMs are rejected. | Evaluated 2026-09-18 against Meta's Muse architecture. The bottleneck is the application, not the isolation layer: 213 MiB is the Node/V8 process, while container overhead measured ~1 MiB. nspawn and Docker use the same namespaces and cgroups, so switching reclaims the `dockerd` daemon once, not per tenant. A microVM per tenant would be *worse* — VMM plus guest kernel on top of the same 213 MiB process. Muse also gives each user a dedicated VM, which is the opposite of a density solution and funded by a fleet we do not have. Its published material discloses no density or overhead figures. |
| Container hardening | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, on top of the image's existing non-root `rocky` user (uid 10001). | Implemented 2026-09-18 and **verified in a live container**, not just in argv: `CapPrm`/`CapEff`/`CapBnd` all read `0000000000000000`, `NoNewPrivs: 1`, `uid=10001(rocky)`. A Node server on a high loopback port needs no capabilities at all, so dropping the full set costs nothing. The pids cap stops a runaway or fork bomb in one tenant exhausting the host PID space and taking down every other tenant. The lesson taken from Meta's Muse, whose runtime cell confines untrusted data — our case exactly, since WhatsApp messages drive a tool-using agent. `--read-only` is **not** set: the runtime writes to `$HOME`, and forcing it would need tmpfs overlays that were not worth the fragility at this stage. Userns remapping is a daemon-level setting, not per-container, so it is a deployment concern rather than an argv one. |
| Cron duration model | The host measures **wake → cron delivery** itself and keeps an EWMA per job in the tenant database. An unseen job is assumed short; an estimate is "unproven" until ~3 observations. | Decided 2026-09-18. OpenClaw records its own `duration_ms` in `cron_run_logs`, but that measures the job, not the slot: it excludes the ~4.4 s cold start and the delivery. Slot occupancy is what scheduling is actually constrained by, and it is entirely our own observation, so no P8 question arises. EWMA rather than a mean because a digest grows with the user's data. The unproven flag stops one anomalous first run from mislabelling a job permanently. |
| Cron queue order | **Shortest predicted job first, with aging.** Any of the 3 cron slots takes any job; there is no per-duration slot partition. | Decided 2026-09-18 after evaluating fixed long/mid/short slots. Worked example — 50 jobs at 09:00, 45 short (~20 s) and 5 long (~5 min): SJF drains the 45 short in ≈5 min, then runs the long ones; fixed classes reserve a slot for long jobs and give short ones only 2, taking ≈7.5 min for the majority while the long slot idles afterwards. The usual argument for partitioning — long jobs starve — does not hold here because cron arrivals are bursty and finite: a batch drains and goes quiet, so long jobs run at the tail. Aging removes the residual risk without a partition. |
| Cron overrun | A job exceeding **3× its predicted duration** is preempted and re-queued, and is **not** recorded as failed. | Decided 2026-09-18. This is the failure a duration-class partition was meant to contain, handled directly instead: one pathological job cannot hold a slot and block the batch. Safe for the same measured reason as interactive preemption — a stopped cron job re-fires once on next wake. Recording a failure would be wrong and would raise false alerts. |
| Shutdown ordering | Mark draining → stop claiming → drain active turns for the grace period → classify unresolved → checkpoint and close tenant databases → stop gateways → stop the server. `scripts/start.mjs` waits the configured grace before `SIGKILL`. | Implemented 2026-09-18 per §8. The previous implementation stopped gateways **first**, killing the runtime out from under in-flight work and leaving the ledger claiming those turns were still running. The old 400 ms force-kill in `start.mjs` was far shorter than a turn drain, so it destroyed exactly the work the drain exists to protect. A pre-commit turn is requeued for full re-execution; a turn that had begun sending becomes `delivery_unknown` and is never blindly resent. |
| Operator surface | `tenant state status/backup/restore` and `tenant turn list`, operator-only. Restore stages, never activates. No `turn resolve`. | Implemented 2026-09-18 per §9. Both return metadata only — a visibility command must not become a transcript export path, which needs its own compliance and authorization design. `turn resolve` is deliberately absent: pre-commit failures re-execute automatically, so there is no side-effect ambiguity to settle; it returns only if write-capable tools are enabled. Restore refuses an unverified backup and refuses a backup belonging to another tenant. |
| Reconciliation safety | Boot reconciliation **refuses to act when the tenant list is empty** but containers exist. It logs an error and removes nothing. | Added 2026-09-18 after it destroyed a live tenant's container mid-turn. A boot smoke test started a gateway with an empty `ROCKY_TENANTS_DIR`; `listTenants()` returned `[]`, so every container looked like an orphan. "Every tenant vanished at once" is far less likely than "this process is pointed at the wrong tenant root" — a test harness, a deploy racing a volume mount, or a second instance. Destroying every container is not an acceptable response to an ambiguous signal. |
| Instance namespace | `ROCKY_INSTANCE_ID` defaults to `local-<hash of resolved tenant root>` in dev, not the bare constant `local`. An explicit value still wins; prod still uses the public base URL or hostname. | The old shared default made the Docker namespace independent of the tenant root, so any process on the host could claim another's containers. Deriving it from the root makes collision structurally impossible rather than a matter of remembering an env var. This is the second half of the fix above: (1) stops the destruction, (2) stops the misattribution that caused it. |
| Connector sidecar | Host-managed service in the same tier as the Rocky gateway, not optional. Boot probes `/health` and warns loudly if unreachable; never fatal. | The sidecar holds the **organisation-wide** Composio project key and derives `acct:<tenant.uid>` from Rocky's signed assertion, so it cannot live inside a tenant container without handing that tenant the org credential. `docker-compose.yml` labels it "local/shared", which reads like dev scaffolding; without the probe a missing sidecar surfaced only as a bare `fetch failed` on a user's first MCP action. |
| Cron delivery wiring | Jobs must carry `delivery.mode=webhook` pointing at Rocky's ingress. The model is instructed to set it, and a **reconciler** rewrites any job that does not (`openclaw cron edit <id> --webhook`) on every mirror refresh. | The global `cron.webhook` was tested and **does not work**: `resolveCronWebhookTargets` reads only per-job `delivery.mode`/`delivery.to` and never falls back to it. Verified empirically — a new job created with `cron.webhook` set still got `mode: announce, to: (none)`. Same class of trap as `skipMissedJobs`: schema-valid, silently ignored. A Zod/TypeBox schema cannot enforce this because the cron tool's schema lives inside OpenClaw; the reconciler is stronger anyway, since it also repairs jobs created before the rule. |
| Cron ingress reachability | A dedicated listener serves only `POST /internal/cron/delivery`, bound to the Docker bridge gateway (`0.0.0.0` fallback). Containers get `--add-host host.docker.internal:host-gateway`. | The ingress was unreachable from any container in two independent ways: `host.docker.internal` does not resolve on Linux without the host mapping, and the main gateway binds `127.0.0.1` only, so the connection was refused regardless of DNS. A separate listener keeps signup, admin APIs and health on loopback. On Linux the bridge gateway is a real host interface reachable only from containers; the `0.0.0.0` fallback exists because Docker Desktop keeps the bridge inside its own VM, and the log says to firewall it. |
| Interrupted write turns | On `attempt > 1` the prompt is prefixed with an instruction to verify whether the work already happened, complete only what is missing, and **ask rather than guess** when it cannot tell. | Operator's design. Needs no tool ledger — Rocky records none, and §6 says none is required. It is **heuristic idempotency, not a guarantee**: a pre-existing similar item can read as "already done" and silently drop a real request, and non-queryable actions ("add 500 to the budget") cannot be verified at all. The escalate-when-unsure clause is what converts the residual risk into a question instead of a silent error. `UNCERTAIN_WRITE` parking remains the backstop. |
| Tenant personal skills | The tenant's Claude account skills, synced by Claude Code into `cli-home/claude/skills/synced/<org>_<account>/`, are added to OpenClaw's `skills.load.extraDirs` per tenant. | Added 2026-09-18. Authentication **does** transport skills — Claude Code syncs them into the tenant CLI home, which is already bind-mounted; OpenClaw simply was not told to look there. Verified: 40 skills loaded, 24 from the synced directory. The path is keyed by organisation and account UUID, so each tenant gets only its own seat's skills. Resolves to nothing when a tenant has not authenticated. |
| Container mounts | Mount only tenant `workspace`, `openclaw`, `cli-home/claude`, and read-only `org`. | Never mount a tenant vault, another tenant, or the whole tenant root. |
| Control plane | One `tenant <resource> <action>` executable/service is the credential, connector, and runtime authority. | No separate tenant-auth/vault/MCP CLIs; agents use a bound in-process client, not shell commands. |
| Authorization | Every tenant action is authorized against a server-resolved tenant grant; operator actions remain operator-only. | A model/message/CLI parameter cannot select another tenant. Operator recovery actions are never AI tools. |
| Secrets | Tenant and platform records use authenticated encryption under `ROCKY_VAULT_MASTER_KEY`; secret input uses stdin. | Never log or put API keys, OAuth codes, assertions, Connect links, MCP headers, or tokens in argv/stdout/audit. |
| Org bundle | Versioned `org/**` is the approved shared content/catalogue; tenant workspaces are personal. | Org skills/templates stay central; user-created material belongs in tenant workspace. |
| Channel | Current code still contains Baileys; production cutover target is Twilio WhatsApp. | Do not extend Baileys as the final channel architecture. **Open regression:** Twilio cannot send outbound quoted replies (no such API parameter), which Baileys can and the current product does — see `backlog.md` BL-008. Decide before the adapter is finished; one option (Meta Cloud API) replaces the provider entirely. |
| MCP path | OpenClaw invokes native Composio MCP tools through its Claude CLI bundle bridge. | No Hermes-style tool executor, provider REST bypass, custom tool proxy, or custom remote-MCP installer. **Per-toolkit `toolFilter` is now required** — see the Tool surface row; the earlier blanket ban on filters is reversed. |
| Toolkit catalogue | The org-approved Composio registry is the only available catalogue. | Users may connect only approved toolkit slugs. Adding a toolkit is an admin code/config/deploy/sync change, not unrestricted marketplace installation. |
| Provider auth | Each user signs into their own Gmail/Asana/Outlook/etc. through Composio Connect. | Composio stores provider OAuth tokens; Rocky stores only encrypted tenant connection/session metadata. |
| Accounts | One active account per tenant per toolkit. | Multiple-account selection/aliasing is deferred in `backlog.md`. |
| iRock reuse | Vendor/adapt connector-only service concepts under `services/composio-connector`; retain Apache attribution. | Do not ship/install the iRock desktop app, CLI, sessions, desktop auth, workspace DB, or its legacy AI runtime. |
| Connector identity | Rocky signs short-lived ES256 service assertions; sidecar derives `acct:<tenant.uid>`. | No iRock desktop login, per-tenant sidecar refresh token, or caller-supplied Composio scope. |
| Sidecar storage | Sidecar Postgres holds operational idempotency/audit only. | It is not a credential vault, transcript database, or provider-token store. |
| Native MCP projection | Project exactly one tenant `composio` MCP server into a short-lived runtime file/tmpfs. | Canonical `openclaw.json` never contains Composio URL/headers; OpenClaw receives the full enabled toolkit surface. |
| Write safety | Do not use tool filters as a safety substitute. | Live write/destructive tool enablement remains blocked until provider/runtime approval behavior is proven. |
| Current exclusions | Google REST/OAuth provider implementation was removed; legacy Google records are quarantined. | No credential import. Users reconnect through Composio. Codex paths are legacy compatibility only; do not extend them. |
| Delivery/recovery | Phase 3C owns durable turn ledger, encrypted transcript, SQLite/WAL, recovery, and Twilio delivery correlation. | These are specified, not implemented. Phase 4 Vikas staging must wait for Phase 3C. |

## Explicit supersessions

- Original shared-seat Claude idea: replaced by tenant-owned Claude Enterprise
  subscription authentication.
- Shared cron service seat: replaced by the tenant’s own connected seat for any
  model-backed cron; scheduler work without a model remains separate future work.
- The legacy iRock AI runtime: rejected. Only connector-service concepts are reused.
- Generic/per-provider MCP and direct Google OAuth: removed in favor of
  Composio-only, native OpenClaw MCP.
- Generic remote MCP installation and user marketplace self-install: not in
  Phase 3B.
- OpenClaw/custom compaction: replaced by Claude Code native compaction.
- Always-on tenant containers: **reversed 2026-09-18**. Idle hibernation with
  host-owned wake scheduling replaces it, and `BL-004` is promoted from deferred
  to core. The always-on rationale ("an evicted container stops firing cron")
  was incomplete — the host can learn when a job is due and wake the container
  in time, so cron survives hibernation. "Idle" still counts only user-initiated
  messages; scheduled job execution never resets the timer.
- Partial turn recovery and the `uncertain` state: replaced by total
  re-execution, valid **only** while the enforced read-only tool filter holds.
- `SPEC-phase3b` decision 12 (no tool filters): **reversed 2026-09-18**. Filters
  are now the enforcement mechanism for the read-only property that total
  re-execution depends on.
- "Missed cron is not recovered because OpenClaw reschedules rather than
  replays", and its replacement "generated config must set
  `cron.skipMissedJobs: true`": **both premises were wrong**, the second
  container-breaking. Upstream defaults already give the wanted behaviour;
  verify any runtime claim against the pinned image before recording it.
- "Scheduled output is delivered but not ledgered" (§1.4b): it was not
  delivered at all. Cron output now joins the canonical outbound path.

## Do not infer these as done

- A live Composio Connect Link, real account connection, and native tool call
  are staging gates, not evidence supplied by unit/Docker tests.
- Twilio cutover, durable transcripts, SQLite turn recovery, Vikas migration,
  cron, payments, custom MCP onboarding, and multiple provider accounts are
  later work.

## 2026-09-20 Pin the runtime tmpfs mode instead of relying on Docker's default

**Decision:** `--tmpfs /run/rocky` now carries an explicit `mode=1777`
(`RUNTIME_TMPFS`, defined once in `src/openclaw/docker-gateway.mjs`). No uid or
gid is specified.

**Why:** Docker applies the tmpfs default mode only when a container is
*created*. On `docker start` of a stopped container it remounts at `0755
root:root`, so uid 10001 loses write access, the entrypoint's `cp` to
`/run/rocky/openclaw.json` fails, `set -e` kills it, and the container exits 1.
Hibernation/wake was therefore broken for every tenant. Reproduced in isolation
with a bare `docker run`/`stop`/`start` cycle; `mode=1777` verified stable
across restart, with the config file still written `0600 rocky:rocky`.

**Rejected alternatives:**
- `mode=0700,uid=10001,gid=10001` — verified working, but hardcodes the image's
  uid into the host control plane. The uid is owned by `Dockerfile.openclaw`
  (`useradd -u 10001`); duplicating it in JS recreates the drift that the pinned
  OpenClaw version already suffered across ten files. Rejected on those grounds.
- Moving the uid into `src/config.mjs` — same duplication, different file.
- Writing the runtime config to `$HOME` instead of a tmpfs — always owned by the
  runtime user, but puts a secret-bearing file (Composio MCP headers) on the
  container's writable layer instead of memory.

**Risks / edge cases found:**
- `1777` is world-writable *inside the container's own mount namespace*. Only
  one non-root user exists there, the sticky bit blocks cross-user deletion, and
  the file itself is `0600`. This is exactly the state Docker produced at create
  time, now made explicit rather than incidental.
- The spec was duplicated in four test files with three different values
  (`size=1m` x3, `size=1048576` x1, none carrying a mode). Those tests spawned
  containers with a *different* mount than production and so could never have
  caught this. All four now import `RUNTIME_TMPFS`; there is one definition.

## 2026-09-20 Warm container pool defaults to 5, not unlimited

**Decision:** `MAX_TENANTS_PER_HOST` defaults to `5` (was `0`). `0` still means
unlimited when set explicitly.

**Why:** `maxWarmTenants()` maps `0` to `Number.POSITIVE_INFINITY`, and nothing
in the tree configured a ceiling — no `rocky.config.json`, no env var. The
intended architecture is at most 5 warm containers per host; the effective
runtime value was `Infinity`. At 2g per container that is an OOM at scale, and
every test that "verified" capacity admission had injected its own ceiling, so
the drift was invisible.

**Rejected alternatives:** leaving the default at `0` and requiring deployments
to set it — the safe value should not be opt-in.

**Risks / edge cases found:** `assertHostCapacity` is checked before the pool
entry exists, so admission is ordered correctly; `scripts/gate-pool.mjs` now
exercises the ceiling with N+1 tenants rather than trusting the unit test.

## 2026-09-20 Message search is decrypt-and-scan, not an FTS index (BL-005)

**Decision:** Keyword search over message bodies is implemented in
`src/tenant-data/search-store.mjs` as a bounded SQL filter followed by
decrypt-and-scan in process. No FTS5 virtual table, no schema change, no new
columns. Literal case-insensitive AND matching over whitespace-separated terms;
the query is never compiled as a pattern.

**Why:** Bodies are sealed with `sealMessageBody`, so an FTS5 index would have
to hold plaintext — it would undo encryption at rest for a regulated firm's
client conversations in order to serve a feature nobody has asked for yet.
Measured on 20,000 encrypted messages in one tenant: 139ms to scan every row
with zero hits (the worst case), 9ms when the result limit is reached early.
At internal-tool volume the index buys nothing an index is for.

**Rejected alternatives:**
- FTS5 over decrypted content — fastest, but defeats the encryption decision.
- Storing bodies raw — simpler, but the threat this protects against (disk
  snapshot, backup leakage) is the realistic one for a VM holding client
  mandates and valuations.
- Deferring search entirely — an earlier claim that deciding late would force a
  data migration was wrong: we hold the vault key, so an index can be built from
  existing rows at any time. Nothing here is one-way.

**Risks / edge cases found:**
- A row whose envelope cannot be opened is skipped and counted in `unreadable`
  rather than failing the whole search, so one corrupt row cannot deny search
  over the rest.
- `scanCap` (default 20,000) bounds the work and the caller is told when the
  scan was truncated, so a large tenant degrades visibly instead of silently
  returning partial results as if they were complete.
- An empty or whitespace-only query returns nothing rather than everything.

## 2026-09-20 Container filesystem paths live in one module

**Decision:** `src/openclaw/container-paths.mjs` is the single definition of
every in-container path. `docker-gateway.mjs` and `tenant-openclaw.mjs` import
it instead of repeating string literals.

**Why:** `/tenant/cli-home/claude` and `/org` were each defined in
`docker-gateway.mjs` (as a mount target) and independently re-asserted in
`tenant-openclaw.mjs`. Changing a mount point in one file would have silently
broken the other at runtime with no test failure — the same failure mode as the
tmpfs spec, which was duplicated across four test files with three different
values and therefore untested in the form production actually used.

**Risks / edge cases found:** the paths are also declared in
`Dockerfile.openclaw`'s `ENV` block, which cannot import JS. That duplication
remains and is the next candidate for a consistency test of the kind that
already guards `OPENCLAW_VERSION`.

## 2026-09-20 Twilio inbound is wired behind a provider-shaped boundary

**Decision:** `src/twilio-webhook.mjs` handles both Twilio webhooks and is
mounted at `/webhooks/twilio/inbound` and `/webhooks/twilio/status`.
`ROCKY_CHANNEL=twilio` now selects `TwilioChannel` in `createChannel()` and fails
closed unless `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
and `ROCKY_PUBLIC_BASE_URL` are all present.

**Why:** `TwilioChannel` had zero callers — the module existed but nothing
imported it, so there was no path from an HTTP request to the router and gate 3
had nothing to exercise. `createChannel()` knew only `mock` and `baileys`, so
`ROCKY_CHANNEL=twilio` silently fell through to Baileys: inbound would have been
accepted while replies went out over the wrong channel.

**Shape chosen:** the handler takes `{ rawBody, signature, url, channel }` and
returns `{ ok, status, body }`, matching `handleCronDelivery`. The raw body is
read as bytes and never re-serialised, and the signature is checked against the
URL derived from `PUBLIC_BASE_URL` rather than the request's `Host` header.

**Rejected alternatives:**
- Reusing `readBody()` — it parses JSON and discards the original bytes. Twilio
  signs URL + sorted params so it would have survived, but Meta's
  `X-Hub-Signature-256` is HMAC over raw bytes, and Meta documents that hashing
  a re-serialised payload yields a different signature. Capturing raw now is
  what keeps the Meta adapter a one-file change.
- Trusting `req.headers.host` for the signed URL — attacker-controlled, and
  wrong behind a proxy that rewrites scheme or port.
- Replying with TwiML — replies are produced asynchronously through
  persist-then-send, so the webhook returns 204 and never a message body.

**Risks / edge cases found:**
- Status callbacks carry only a `MessageSid`, but each tenant has its own
  database, so there is no way to know which store to update. Resolved by
  appending `?t=<tenantId>` to the per-message `StatusCallback` URL; the query
  string is part of what Twilio signs, so the scope cannot be altered in flight.
- `?t=` is nonetheless attacker-chosen within a validly signed request. An
  unknown or malformed tenant id made `openTenantStore` throw and crashed the
  request; it now returns 204 and records the reason. Found by gate 3, not review.
- Replayed webhooks reach the router twice by design — deduplication belongs to
  `queue-store` on `(channel, channel_account, external_message_id)`, not to the
  channel boundary.
- `ROCKY_PUBLIC_BASE_URL` must match the URL Twilio actually calls, exactly.
  A mismatch fails every signature rather than degrading, which is the correct
  direction but gives a confusing symptom.

## 2026-09-20 Crash recovery for turns left mid-send

**Decision:** `recoverTenantLane` (the boot path) now calls
`markSendStartedUnknown(store, 'CRASH')` in addition to
`recoverInterruptedTurns`, and `markSendStartedUnknown` is actually imported
into `src/inbound-queue.mjs`.

**Why:** the symbol was never imported, yet `classifyUnresolvedTurns` already
referenced it on the graceful-shutdown path — inside a `try/catch` that
swallowed the resulting `ReferenceError` as a warning. So reclassification of
`send_started` turns had never run, on crash or on clean shutdown.

This matters more than it first appears because `send_started` is not a brief
window. `recordSendResult` deliberately leaves a turn there until a provider
status callback arrives (`delivery-store.mjs`: provider acceptance is not
delivery, and Twilio reports `queued` synchronously). A turn can legitimately
sit in `send_started` for a long time, so any interruption in that window
stranded it permanently — and because the state is non-terminal, the tenant's
lane treated work as in flight and answered every later message with the
busy-ack instead of running it. A silent, permanent, per-tenant deadlock.

**Rejected alternatives:** completing the turn on provider acceptance. That
would make a later `failed` callback unable to correct the record, which the
delivery store documents as the reason it waits.

**Risks / edge cases found:** the bug was invisible because the `try/catch`
around the shutdown call logged a warning and continued. Surfaced only because
the new boot-path call sat outside that guard and crashed a test loudly.

## 2026-09-20 Cron preemption must not stop a container serving a user

**Decision:** `preemptOverruns` re-queues an overrunning cron job but leaves the
container running when `deps.inFlight(tenantId)` is true; `src/index.mjs` wires
that to `tenantInFlight(id) > 0`.

**Why:** preemption called `deps.hibernate(tenantId)` unconditionally. An
overrunning cron on a tenant that was also serving a WhatsApp message stopped
the container mid-turn and lost the user's reply — the direct opposite of
"interactive work outranks cron". `yieldSlotForInteractive` already protected
the other direction; this side was unguarded.

**Risks / edge cases found:** observed live, not by inspection — two orphaned
cron jobs from earlier gate 2 runs kept firing and killed an interactive turn
during gate 3. Gate 2's own cleanup ran `docker exec` *after* hibernating the
container, so it always failed, and the failure was swallowed by `.catch(() => {})`.
Cleanup now restarts the container first and reports loudly if the job survives.

## 2026-09-20 A stopped container with a missing bind-mount source is recreated

**Decision:** `containerMountsIntact(name)` checks every bind-mount source before
`docker start`; if any is gone the container is removed and recreated.

**Why:** the Composio MCP projection lives under `os.tmpdir()`, and bind mounts
are fixed at container *create* time. When the OS cleans temp — macOS on reboot,
systemd-tmpfiles on a timer — `docker start` fails permanently with
`not a directory: are you trying to mount a directory onto a file`, and the
tenant can never wake again. Hibernation makes this likely rather than exotic,
because the container is stopped for long stretches.

**Rejected alternatives:** moving the projection under the tenant directory.
It would survive, but it puts a short-lived credential projection on persistent
disk, which is what keeping it in the runtime directory deliberately avoids.

**Risks / edge cases found:** the guard is general — it covers any vanished
mount source, not just the Composio projection.

## 2026-09-20 Product code stays environment-agnostic; test seams are prod-forbidden

**Decision:** `TWILIO_API_ROOT` (the override that lets a test point the Twilio
client at a local mock) is a fatal startup error under `ROCKY_PROFILE=prod`, and
so is running the twilio channel without an explicit `ROCKY_PUBLIC_BASE_URL`.
The cron ingress no longer falls back to `0.0.0.0` in prod; it disables cron
delivery instead of binding wider than intended.

**Why:** the product source must behave the same on localhost, behind Caddy and
on public DNS — the only difference should be configuration. `TWILIO_API_ROOT`
was introduced so `gate3:local` could exercise the real send path without
messaging a real phone, but left unguarded it is also an exfiltration vector:
one env var silently redirects every outbound WhatsApp message to an arbitrary
host. Keeping the seam but making it impossible in prod preserves the test
without weakening the deployment.

`PUBLIC_BASE_URL` defaults to `http://127.0.0.1:<port>`, which is a sane dev
default and a silent disaster in prod — every webhook signature is computed
against it, so a forgotten override fails 100% of requests with 403. Prod now
refuses to start instead.

**Audit result (product source, not tests):** the remaining loopback literals
are deliberate architecture, not local shortcuts — Rocky binds `127.0.0.1` and a
reverse proxy fronts it; container ports are published to loopback only;
the Composio sidecar is asserted to be loopback; `host.docker.internal` resolves
on Linux too because `--add-host host.docker.internal:host-gateway` is passed.
`src/cli-mock.mjs` is a dev tool and not on any product path.

**Risks / edge cases found:** the `0.0.0.0` fallback only ever triggered on
`EADDRNOTAVAIL`, which is the Docker Desktop case where the bridge lives inside
a VM. On Linux the bridge is a real interface and the fallback never fired — so
the divergence was latent rather than active, and would only have appeared if
the bridge were renamed or absent on a server.

## 2026-09-20 Container logs persist to the tenant mount; cron delivery uses the public route

**Decision:** every tenant's `openclaw.json` now sets
`logging.file = /tenant/openclaw/logs/gateway.log`, `logging.maxFileBytes`
(32 MiB default) and `logging.redactSensitive = "tools"`. `CRON_WEBHOOK_URL`
derives from `PUBLIC_BASE_URL` whenever that is a public address, falling back
to `host.docker.internal` only for local development.

**Why (logs):** OpenClaw defaulted to `/tmp/openclaw-<uid>/openclaw-<date>.log`,
inside the container's writable layer. That is lost on every container recreate
— which reconciliation, credential rotation and the new missing-mount recovery
all trigger — and it is unreadable from the host, so there was no operational
record of what an agent did on a tenant's behalf. `/tenant/openclaw` is already
a host bind mount, so writing there persists the log beside the session state it
describes. Verified: 14,256 bytes before `docker rm -f`, 29,857 after recreate,
same file, history intact.

**Why (cron):** the `url-fetch` guard refuses
`private/internal/special-use IP address` destinations, so the webhook to
`host.docker.internal` was blocked. `openclaw config schema` on the pinned image
exposes only `allowRfc2544BenchmarkRange` and `allowIpv6UniqueLocalRange` under
`tools.web.fetch.ssrfPolicy` — there is no private-network allow to enable, so a
blanket allowlist was not achievable and was not faked. A public destination is
already permitted, so pointing the webhook at the deployment's own public URL
clears the guard without weakening it.

**Rejected alternatives:**
- `logging.redactSensitive: true` — rejected by the config validator; the key is
  an enum of `"off"` or `"tools"`. Caught only by starting the real container.
- Mounting a host directory over `/tmp/openclaw-<uid>` — would work, but binds
  the host control plane to the image's uid, the coupling deliberately removed
  when the tmpfs mode was pinned.
- Weakening the SSRF policy — not expressible in this image's schema.

**Risks / edge cases found:** scheduled output now leaves the host and returns
over the public internet. Recorded as **BL-011** for security review before
scheduled jobs carry client content. `cronWebhookReachable()` is the single
predicate deciding whether the configured URL is reachable from a container, so
a loopback `PUBLIC_BASE_URL` reports unreachable instead of silently failing at
delivery time.

## 2026-09-20 The channel is a provider port, not a Twilio integration

**Decision:** `src/channels/` holds the provider contract. `port.mjs` defines
the adapter shape, the normalized inbound/status envelopes and a capability
descriptor; `index.mjs` is a registry plus provider-agnostic webhook handlers;
`twilio.mjs` is the only adapter today. `src/index.mjs` selects a provider by
`ROCKY_CHANNEL`, derives its webhook paths from the registry, and no longer
mentions Twilio anywhere. `src/twilio-webhook.mjs` remains as a thin
compatibility shim over the port.

**Why:** adding a second provider must not touch routing, the router, the
delivery store or `package.json`. An adapter supplies `verifyInbound`,
`parseInbound`, `parseStatus`, `createChannel`, `tenantFromStatusQuery`,
`verificationChallenge` and `capabilities` — nothing else in the tree changes.
Both Twilio and Meta are reachable with `node:crypto` and `fetch`, so **no
dependency changes are required to switch**, and `ROCKY_CHANNEL=<unknown>` now
fails at startup listing the known providers instead of silently falling
through to Baileys.

**Callback shape is stable across providers:** routes are
`/webhooks/<provider>/inbound` and `/webhooks/<provider>/status` (both
overridable so an existing console entry can be matched without a console
change), the status callback carries `?t=<tenantId>` inside the signed URL, and
the handler always returns 204 with no body. A GET on either path is offered to
`verificationChallenge` first, which is what Meta's `hub.challenge` handshake
needs — Twilio returns null and the GET falls through.

**Capabilities are declared, not assumed:** `quoteOutbound`, `mediaOutbound`,
`mediaPerMessage`, `mediaNeedsPublicUrl`, `mediaFilename`, `mediaCaption`,
`inboundReplyContext`, `inboundReplyWindowDays`. Twilio declares
`quoteOutbound: false`, `mediaFilename: false`, `mediaCaption: false`,
`mediaPerMessage: 1` — the real limits found in its documentation — so product
code degrades against a declared capability instead of discovering the gap in
production.

**Rejected alternatives:** a Twilio SDK dependency. It would add a package that
a Meta switch then has to remove, and Twilio's own advice to use their validator
is outweighed here by keeping the dependency set identical across providers.
The undocumented port-variant behaviour of their validator is recorded as a risk
in the gate 3 notes rather than resolved by taking the dependency.

## 2026-09-20 Claude CLI state and MCP logs persist with the tenant

**Decision:** the entrypoint links `$HOME/.claude.json` to
`$CLAUDE_CONFIG_DIR/.claude.json` and `$HOME/.cache/claude-cli-nodejs` to
`$CLAUDE_CONFIG_DIR/cli-cache`, migrating any container-local copy into the
mount once before linking.

**Why:** `docker diff` on a live container showed both were on the writable
layer, so both were lost on every recreate. `.claude.json` (41 KB in practice)
holds `oauthAccount`, `userID`, `machineID` and CLI migration flags — losing it
churns the machine identity and re-runs migrations each time. The cache holds
`mcp-logs-openclaw` and `mcp-logs-composio` JSONL, which record **which tools an
agent actually invoked on a tenant's behalf** — audit material for a regulated
firm, and previously destroyed with the container.

Measured side effect: with `.claude.json` persisted, a warm turn went from
10.0s to 5.0s, because the CLI no longer rebuilds that state per container.

**Risks / edge cases found:** after this change the only writable-layer paths
left are `/tmp/cc-socks`, `/tmp/claude-10001` and `/tmp/openclaw-10001` —
sockets and lock files, which must stay ephemeral. The entrypoint contract test
was extended rather than relaxed: every `$HOME/.claude*` line must still be a
link into the mount, and `CLAUDE_STATE_FILE` is asserted to derive from
`CLAUDE_CONFIG_DIR` so the link cannot point at a container-local path.

## 2026-09-20 Codex persistence is on hold until Claude is stable in prod

**Decision:** Codex state is not persisted and `cli-home` stays mounted as
`cli-home/claude` only. Reverted the change that mounted the whole `cli-home`
and linked `$HOME/.codex` into `$CODEX_HOME`.

**Why:** the Claude path ships first. Mounting `cli-home` as one unit changed
the container's mount surface and broke two live Docker gates (`cold start and
recreate`, `isolation`), which is unnecessary risk for a runtime nobody is using
yet. Sequencing it after prod is stable keeps the mount contract unchanged.

**What is left undone deliberately:** `CODEX_HOME=/tenant/cli-home/codex` is set
in the image but that path is **not** on a mount, so any Codex state and its
`$HOME/.codex` logs live on the container's writable layer and are destroyed on
recreate. This is known and accepted while Codex is unused. Revisit with the
same treatment Claude got — mount the parent `cli-home`, link `$HOME/.codex`,
and update `container-mounts-contract.test.mjs`, which asserts the exact mount
set and will fail until it is updated deliberately.

## 2026-09-20 The turn prompt carries tool state, reply reference and search hits

**Decision:** `src/tenant-data/turn-context.mjs` builds three preambles that are
prepended to every turn, ahead of the transcript replay:

1. `toolAvailabilityPreamble` — distinguishes "no toolkits connected for this
   user" from "the connector is unreachable", and in both cases forbids the
   agent from claiming external work it cannot do.
2. `quotedReplyPreamble` — resolves the provider's reply reference to the
   quoted message's text. When the reference cannot be resolved it says so and
   names the reason (Twilio only attaches reply context for 7 days).
3. `relatedContextPreamble` — when the message cannot stand alone, searches the
   durable transcript and offers candidates, instructing the agent to name what
   it thinks was meant and ask for confirmation rather than guess.

Migration 004 adds `messages.reply_to_external_id`, storing the *provider's* id
so it stays meaningful across a provider switch.

**Why:** all three were built and then never reached the agent.
`replyToExternalId` was extracted in the channel and silently dropped at
`enqueueForTenant`, which only forwarded `{conversationId, channel,
channelAccount, externalMessageId, body}`. `searchMessages` had **zero callers**
— the search existed but nothing could invoke it. And with no MCP toolkits
connected the agent answered a Gmail request with an apology about its own
reply rather than saying tool access was unavailable.

**Trigger for search, deliberately narrow:** three words or fewer, or a strong
referential phrase ("the same", "you said", "what about") within 25 words, or a
weak one ("this", "that") within 8. A bare "this" is ordinary English — "draft
the agreement for the Mumbai mandate this week" must not trigger archaeology,
and a test asserts exactly that.

**Rejected alternatives:**
- Exposing search to the agent as an MCP tool — needs a live connector, adds a
  round trip per turn, and fails exactly when the connector is down, which is
  one of the cases this is meant to handle.
- Always searching — wasted work on self-contained messages, and it pollutes the
  prompt with weak matches that invite the agent to answer the wrong question.

**Risks / edge cases found:** the search never returns the message being
answered (the turn's own message ids are excluded), or it would cite the user
to themselves. Verified live: `[search] 2 related message(s) for [gmail]`
produced "Are you asking whether the Gmail approval for the deal team has come
through yet, or whether we can try using it now?", and a quoted reply to an
earlier message resolved "any update on this?" to the Gmail thread.

## 2026-09-20 The agent talks to a WhatsApp user, not an operator

**Decision:** `audiencePreamble()` is prepended to **every** turn: the reader
cannot restart services, open dashboards or run commands, does not know what
OpenClaw, Composio, a connector or a container is, and must never be asked to
fix infrastructure. Broken capability is reported as "unavailable, being
handled" with no internal names.

**Why:** with tools unavailable the agent told a real user "Can you try
restarting OpenClaw's gateway to bring composio back online?" and offered to
"walk you through the OpenClaw composio settings manually using the browser".

**The design error, worth recording:** the rule was first folded into
`toolAvailabilityPreamble`, which returns an empty string when toolkits *are*
connected — so the guidance vanished in the normal case. The live retest still
leaked "OpenClaw composio settings" and that is how it was caught. It is now
its own always-on preamble, and a test asserts it is independent of tool state.

## 2026-09-20 Outbound text is normalised to WhatsApp markup before commit

**Decision:** `src/whatsapp-format.mjs` converts the Markdown subset models
reach for into what WhatsApp renders (`**b**`→`*b*`, `## H`→`*H*`, `-`→`•`,
`[a](url)`→`a: url`, inline backticks stripped, fences kept). Applied in
`router.mjs` **before** `deliverResponse`, so the committed bytes are exactly
the bytes sent and the persist-before-send envelope still holds.

**Why:** WhatsApp is not Markdown. A reply rendered as
`1. *Composio isn't running* — …` with literal asterisks visible.

**Risks / edge cases found:** fenced blocks are extracted before any other
substitution, so `**not bold**` inside code survives; `2 * 3 = 6` is untouched.

## 2026-09-20 Typing indicator doubles as the read receipt

**Decision:** `TwilioChannel.setTyping` posts to
`POST https://messaging.twilio.com/v3/Indicators/Typing.json` with
`{channel:"WHATSAPP", messageId}`. A heartbeat starts at turn start and
refreshes every 20s (Twilio expires it at 25s, and a cold container start is
~24s), stopping in a `finally` so a failed turn never leaves a user watching a
bubble. Capability flags `typingIndicator` / `readReceipts` are declared on the
adapter.

**Why:** the existing code said "WhatsApp Business API exposes no typing
indicator through Twilio". That was **out of date** — Twilio shipped it in June
2026. Twilio also marks the referenced inbound message read as a documented side
effect, so one call produces both the typing animation and the sender's blue
ticks; no separate read-receipt API is needed.

**Risks / edge cases found:** the docs specify API Key + Secret auth, but the
existing Account SID + Auth Token works (verified live: `{"ok":true}`). It is a
different host from the 2010-04-01 API, so `TWILIO_MESSAGING_V3_ROOT` is
separately overridable. Failure is swallowed by design — a cosmetic indicator
must never fail a turn.

## 2026-09-20 Command intents match the user's words, not the assembled prompt

**Decision:** the router passes `commandText` (the raw inbound text) alongside
`text` (the model prompt). `runAgentTurn` matches connect intents against
`commandText`, never the prompt.

**Why:** every intent in `src/connect.mjs` is anchored with `^`, and the prompt
is prefixed with preambles and replayed transcript. So `connect gmail` matched
only for a tenant with no context to replay — for everyone else it fell through
to the model, which invented an authorisation flow. Observed live: the agent
told the user "calendar connection is starting, you should see a prompt on your
device", then "calendar authorization happens through your account settings".
Neither existed; nothing had been started.

**Risks / edge cases found:** the Connect link is returned by `connect` and
never stored, so a half-finished attempt left the user stranded — a second
`connect` returns "already connected or pending" with no link. `connectToolkit`
now inspects status: an ACTIVE connection is reported as already connected and
left alone; an INITIALIZING one carries no authorisation, so it is discarded and
a fresh link minted.

## 2026-09-20 Deploys must never carry platform/ to a target

**Decision:** `deploy/push.sh` rsyncs with `--exclude-from
deploy/rsync-exclude.txt`, which excludes `platform/`, `tenants/`, `.env.local`
and `baileys_auth/`. A test asserts the list and that the script uses it rather
than inline flags.

**Why:** an ordinary deploy re-copied the laptop's `platform/vault/` over
production's. Those records are encrypted with each environment's own
`ROCKY_VAULT_MASTER_KEY`, so prod's Composio credentials became unreadable —
every MCP call failed with `Vault key mismatch for composio-platform`. It was
diagnosed only by noticing the file's mtime was three days old: the deploy had
silently restored a dev-keyed record. This had already happened once and been
"fixed" by re-keying, which the next deploy undid.

**Risks / edge cases found:** inline `--exclude` flags were how the mistake
survived — each ad-hoc rsync repeated a hand-written list and `platform/` was
never on it. The exclude list is now one file, used by one script, pinned by a
test.

## 2026-09-20 Connected tools are stated in the present tense, and the envelope is unwrapped

**Decision:** `toolAvailabilityPreamble` names the connected toolkits on every
turn and tells the agent to use them and to disregard older turns claiming they
are unavailable. `toolAvailability` reads `envelope.result.connections`, and a
non-array throws rather than degrading to "nothing connected".

**Why:** with Google Calendar genuinely connected (`ACTIVE`, and
`openclaw mcp probe` reporting `composio: 6 tools`), the agent refused a
calendar request three times and never attempted a tool call. Two separate
faults stacked:

1. The preamble returned an empty string when tools *were* connected. The
   replayed transcript contained several older turns saying calendar was
   unavailable, and with no present-tense statement of capability the agent
   simply repeated them.
2. `mcp().list()` returns the command envelope `{ok, resource, action, result}`,
   but the router read `.connections` off the envelope rather than off
   `.result`. That yielded `[]` with no error, so even after fix (1) the
   preamble still said nothing. A standalone probe used `.result` and looked
   correct, which is what made it confusing.

Diagnosed by logging `preamble=<bytes> tools=stated|none` at assembly: it read
`tools=none` while the connector reported the toolkit as active.

**Risks / edge cases found:** silence is not neutral when a transcript is
replayed — absence of a capability statement is read as absence of capability.
Any future preamble that "says nothing when everything is fine" has the same
failure mode.

## 2026-09-20 A new MCP connection recycles the tenant container

**Decision:** the Composio OAuth callback verifies the connection against the
connector, recycles the tenant gateway, then notifies the user on WhatsApp.

**Why:** the entrypoint copies the MCP projection into the container's config at
boot, so a toolkit connected afterwards is invisible to the running agent —
measured: projection written 69s *after* the container started. The callback
itself was a static page that said "Connected" unconditionally, verified
nothing, and told nobody.

**Also fixed:** `/connect/*` was not routed to Rocky, so Caddy's fallback
`basicauth` answered the OAuth return with 401 — that was the browser username
and password prompt the user saw, and why the callback never ran despite Caddy
logging two hits.

**Rejected alternative:** `openclaw mcp reload` ("dispose cached MCP runtimes so
new config is used on the next turn") is cheaper than a container recycle and
avoids a cold start. It needs an exec into a running container and a fallback
when none is running, so recycle ships first; reload is the better steady state.

## 2026-09-20 Connecting a toolkit costs nothing — no restart, no reload

**Decision:** the Composio OAuth callback invalidates Rocky's cached tool state
and does nothing else. The container is not recycled and OpenClaw is not
reloaded.

**Why:** the previous commit recycled the tenant container on every connection,
costing a full cold start (~4s plus the entrypoint) on an action the user
experiences as instantaneous. The measurement that settled it:
`openclaw mcp probe` reports **`composio: 6 tools` with one toolkit connected
and still 6 with two**. The Composio MCP endpoint is a fixed generic tool
surface that resolves toolkits server-side at call time, so a new connection
changes nothing the running agent can see. The recycle was solving a problem
that did not exist.

**What actually caused the symptom:** `toolAvailability` caches for 60s. The
callback announced "asana is connected", and the very next message was answered
from a cached state that predated it — so the agent said Asana was not
connected, then used it successfully a minute later. The cache is now dropped
the moment a connection completes.

**Rejected alternatives:**
- `openclaw mcp reload` — cheaper than a recycle and the right tool if the MCP
  surface ever did change per toolkit. It does not here, so it would be
  ceremony.
- Removing the cache — it exists because `toolAvailability` runs on every turn
  and a loopback round trip per turn is latency on the user's reply.

**Risks / edge cases found:** this reasoning is specific to Composio's
tool-router shape. A provider whose MCP server exposes per-toolkit tools would
need the reload path, so the invalidation hook is the seam where that would go.

## 2026-09-20 Coalesced messages are numbered; the busy ack is removed

**Decision:** when a turn carries several inbound messages the prompt says so
and numbers them. The "finishing your previous message" ack is deleted.

**Why:** the ack described a queue that does not exist. Coalescing is a database
property — a new message joins a turn that is still `queued` — so a coalesced
message is answered *in that same turn*, not afterwards. The ack promised a
second reply that was never coming, and the two messages reached the model as
one undifferentiated blob, so it answered one and ignored the other.

**No timer was involved, and none was added.** `INBOUND_COALESCE_MS` is
declared in config and referenced nowhere — dead since before this work. The
coalescing window is "did the previous turn start yet", which in practice is
sub-second, and that is already the behaviour asked for.

**Rejected alternatives:** a real time-window coalescer. It adds a timer, a
flush path and a crash-recovery question, to approximate what the queue state
already expresses exactly.

**Risks / edge cases found:** every message keeps its own `messages` row
regardless of coalescing, so the ledger never loses one — pinned by a test,
because the numbering happens at prompt assembly and could otherwise be mistaken
for a storage change.

## 2026-09-20 An `agent` grant lets the model run tenant commands

**Decision:** a fourth grant kind, `agent`, alongside `operator`, `tenant`,
`runtime` and `oauth-callback`. Resources opt in by declaring `agentActions`;
`mcp` declares `available, tools, list, status, connect`. `createTenantAgentClient`
is the only way to obtain one.

**Why:** connect flows were matched by regex on the user's exact phrasing, so
"connect calendar" worked and "I'd like to hook up my calendar" did not. The
model should decide the intent and run the command, which means it needs a
grant of its own — narrower than the tenant grant a person gets.

**The safety property is structural, not a denylist.** A resource that declares
no `agentActions` is unreachable, so vault, auth, user, route, org, turn and
tenant lifecycle are all out of scope without anyone maintaining a list. Adding
a capability is a deliberate edit to that resource's definition, which is
reviewable. A test asserts the default-deny on a synthetic resource so the
property cannot regress if the grant is later refactored.

**`disconnect` is deliberately excluded.** It is destructive and recoverable
only by the user re-authorising in a browser, which the agent cannot do for
them. A model acting on untrusted WhatsApp input should not be able to sever a
connection.

**Risks / edge cases found:** the grant carries the tenant id, and an explicit
target that disagrees is rejected — so a model cannot reach another tenant even
if it constructs the request itself.

## 2026-09-20 The org registry pins the Composio auth config

**Decision:** a toolkit entry may carry `authConfigId`. When present the
connector uses exactly that auth config; when absent it keeps the old behaviour
of scanning for an OAUTH2 config.

**Why:** the connector called `auth_configs.list()` and took the first OAUTH2
match, which is Composio's shared managed app. For Gmail that consent screen
asks for Google People API scopes — date of birth, street addresses, personal
phone numbers, contacts — none of which a mail integration needs. Observed on a
real connect.

**Tool filters cannot fix this.** `toolFilter.include` restricts which tools
OpenClaw may call *after* the connection exists; the consent screen is decided
by the OAuth client and scopes on the auth config, a different layer entirely.
Filtering tools would have left the over-broad grant in place and merely hidden
it.

**Remaining work, which is configuration rather than code:** create an auth
config in Composio backed by BugleRock's own Google OAuth client with only the
Gmail scopes in use, then put its id in `org/mcp/registry.json`. Until that
exists the default is unchanged, so this commit does not by itself narrow
anything.

## 2026-09-20 Container bring-up is an ordered, mandatory sequence

**Decision:** `src/openclaw/tenant-onboarding.mjs` declares the bring-up steps
as *data* with the phases each belongs to (`create`, `wake`).
`runTenantOnboarding` executes them in order and stops at the first required
failure; both the create path and the wake path in `tenant-gateway.mjs` call it,
and a container is not treated as usable until its phase passes.

**Why:** the preconditions had accumulated as inline statements scattered
through two long functions — quarantine here, mount-access there, mount
integrity somewhere else — and each new one was added wherever the author
happened to be reading. That is how the mount-access grant ended up on the
create path but not the wake path, and how a `docker start` could run before
the host had granted the container read access to files written while it slept.
As data the order is reviewable, and a step cannot be skipped by an early
return in the middle of a function.

**Phase matters, not just order:** `bind-mount sources still exist` runs only on
wake, because a container being created has no mounts to check yet. A test
asserts that split so the two phases cannot silently converge.

## 2026-09-20 The agent credential is per tenant and outlives its container

**Decision:** `ensureAgentCredential` mints a 32-byte token once and stores it
in the tenant's gateway metadata, which lives in the tenant directory. Creating,
rebuilding or waking a container reuses it; it is never rotated as a side effect
of container lifecycle.

**Why:** the credential authenticates the agent's own scoped tenant commands and
will be baked into the MCP server entry inside the container's config. Rotating
it on a rebuild would leave a running agent holding a token the host no longer
accepts — failing at the moment a user asks it to connect something, which is
the worst possible time.

**Risks / edge cases found, caught by a live test rather than review:**
`dockerRunGateway` wrote the gateway metadata wholesale, so every container
rebuild silently discarded `agentToken` and the next call re-minted it. Measured
on the deployment host: `credential after wake: MINTED`. The write now merges,
and a regression test rebuilds the metadata the way `dockerRunGateway` does and
asserts the credential survives.

## 2026-09-20 Rocky serves its own tools to the agent over MCP

**Decision:** `src/agent-mcp.mjs` exposes four tools —
`list_connected_accounts`, `list_available_toolkits`, `connection_status`,
`connect_account` — as a JSON-RPC MCP server mounted on the bridge listener at
`/internal/agent/mcp`. Every call runs under the tenant's `agent` grant. The
projection writes it into the container config as a second `mcp.servers` entry
named `rocky`, authenticated with the tenant's stable agent credential.

**Why Rocky and not the Composio connector:** the connector is a REST service
Rocky calls; the container never talks to it, and teaching it MCP would mean a
protocol implementation in a second language for tools that are Rocky's own.
Rocky already has the tenant CLI, already runs an HTTP server, and already has a
socket containers can reach and the internet cannot — the Docker bridge, where
the cron ingress lives. Mounting there added an endpoint, not a service.

**Why not keep the regex:** `connect calendar` matched, `I'd like to hook up my
calendar` did not, and every new phrasing meant another pattern. Handing the
model a tool moves intent recognition to the thing that is good at it. The MCP
half of `src/agent.mjs` is deleted — the file is now 49 lines and does one
thing. Provider login stays deterministic there, because it bootstraps the very
model that would otherwise interpret the request.

**Verified end to end on the deployment host:** `openclaw mcp probe` reports
`composio: 6 tools` and `rocky: 4 tools`; `list_connected_accounts` returns the
live connection set through the transport; `disconnect_account` is rejected as
an unknown tool because it is not in `AGENT_TOOLS`; a wrong bearer token gets
401.

**Risks / edge cases found:**
- Host→bridge is not routable on this kernel, so the endpoint can only be
  exercised from inside a container. Testing it from the host returns an empty
  body and looks like a server bug.
- A refused capability is returned as a *tool result* with `isError`, not a
  transport error, so the model reads the reason and can tell the user. A
  transport error would surface as an opaque failure.
- The token maps to exactly one tenant and the request cannot name a tenant, so
  a container can only ever act as itself.

## 2026-09-20 Outbound media: signed, expiring links served by Rocky

**Decision:** Files leave the agent through one tool, `send_file_to_user`, which
resolves a workspace-relative path, mints a short-lived HMAC-signed URL under
`/files/…` and hands that URL to the channel. Rocky serves the bytes itself
(`src/media-host.mjs`); `/files/*` is routed through Caddy ahead of the
basic-auth rules. The signing key is `ROCKY_MEDIA_SIGNING_KEY`, generated per
host.

**Why:** Twilio does not accept an upload — it fetches the media from a URL we
publish, so the file has to be publicly reachable for the duration of the send
and must not be reachable afterwards. A signed expiring link is the smallest
thing that satisfies both. The channel never sees a filesystem path and the
model never chooses the recipient: `configureAgentDelivery` supplies both the
channel and the address the turn is bound to, so a model cannot redirect a file
to an address of its own choosing.

**Rejected alternatives:**
- *Static public directory.* Anything ever written there stays fetchable
  forever by anyone who learns the name. Client documents cannot live there.
- *Twilio Media/Content API upload.* Ties the code to Twilio at the point we
  are trying to keep provider-agnostic for the Meta Cloud API move, and Meta's
  upload model is different again.
- *Serving from Caddy directly.* Caddy would need the tenant root mounted and
  its own copy of the signing logic; path traversal then has two implementations
  instead of one.

**Risks / edge cases found:**
- `resolveWorkspaceFile` must reject any path that escapes the tenant
  workspace; it throws `Path is outside the workspace`. This is the whole
  boundary — a traversal here reads another tenant's files.
- Twilio fetches with `TwilioProxy/1.1` and no credentials, so `/files/*` had to
  be excluded from the basic-auth route set. Verified in the Caddy access log:
  two `200`s from `TwilioProxy/1.1` for one send.
- The link outlives the send by its TTL. Anyone holding the URL within that
  window can fetch it. The TTL is the exposure, so it is kept short rather than
  convenient.
- Twilio accepts one media item per message, so multi-file delivery is several
  messages, not one.
- **The agent will happily not call the tool.** Observed live: asked for a
  deck, it built a `.pptx`, printed `/tenant/workspace/…` and said "ready to
  download and share" — it had hallucinated delivery. The tool being advertised
  (`openclaw mcp probe` → `rocky: 5 tools`) is not sufficient; the model has to
  be told that a workspace path is not a deliverable. See the next entry.

## 2026-09-20 The audience rule states that the user has no filesystem

**Decision:** `AUDIENCE_RULE` in `src/tenant-data/turn-context.mjs` — applied on
every turn — now also says the user has no filesystem, that a file does not
exist for them until `send_file_to_user` returns success, and that a workspace
path, "ready to download" and "ready to share" are never acceptable answers.

**Why:** This is the same failure as the infrastructure-talk rule that preceded
it: the model reasons about its own environment and reports its own state as if
the user shared it. Twice now the fix has been to state the channel's truth in
the always-on preamble rather than to hope the tool description carries it. A
tool description is read when the model is already deciding to use a tool; it
does nothing when the model has decided the job is finished.

**Rejected alternatives:**
- *Stronger wording in the tool description alone.* Already tried — the
  description says "Use this instead of describing a document you cannot
  deliver" and the model still described one.
- *Auto-sending any file the agent creates.* Sends drafts, scratch files and
  intermediates to the user, and takes the decision away from the turn that
  understands the request.

**Risks / edge cases found:**
- The rule is prompt-level, so it reduces the failure rather than eliminating
  it. The durable check is that the user notices a missing file immediately;
  there is no silent-failure mode here.

## 2026-09-20 Inbound media is fetched on receipt, never stored as a URL

**Decision:** Every `MediaUrl` on an inbound message is fetched immediately into
`tenants/<id>/workspace/inbox/` under a generated name, with the provider's
credentials supplied by the channel adapter's `mediaAuth()`. The transcript
stores a representation per kind (`src/inbound-media.mjs`), never the URL:
audio stores the transcript as the body, image and video store a marker, a
document stores name, type and size. Migration 005 adds the `attachments`
column.

**Why:** Provider links are short-lived and credentialed — Twilio's for hours,
Meta's for minutes, with inbound media retained only seven days — so any code
that keeps a URL and fetches it later works in test and fails in production, and
breaks outright on a provider switch. Fetching on receipt also means the bytes
are in the tenant's own workspace, which is what the container can actually
read.

A transcript is encrypted text; it cannot hold bytes. Pretending otherwise
makes the ledger lie about what was said, so each kind gets the representation
that is true for it. A transcribed voice note is the one case where the stored
text genuinely is the user's words, so it is stored as the body and matches a
keyword search for those words. An image never gets an invented caption.

**Rejected alternatives:**
- *Store the media URL and fetch lazily.* Expires; leaks a credentialed URL into
  the database.
- *Base64 the bytes into the transcript.* Bloats an encrypted store that exists
  to be searched as text.
- *OCR/caption images at ingest.* A second model guessing at a picture, stored
  as if it were fact. The agent sees the file and describes what is actually
  there.

**Risks / edge cases found:**
- A failed fetch is recorded as a failed attachment rather than dropped. The
  user did send something, and the agent must say so rather than answer as if
  the message were empty.
- Size is capped (`ROCKY_INBOUND_MEDIA_MAX_BYTES`, 16 MB) and the fetch is
  bounded by a timeout, or one large send blocks a turn.
- The declared content type comes from the response header, not the webhook
  field, since the two can disagree.

## 2026-09-20 Voice notes are transcribed locally, by whisper.cpp in the tenant image

**Decision:** `rocky-transcribe` is baked into the tenant image: ffmpeg converts
the OGG/Opus voice note to 16 kHz mono WAV and `whisper-cli` prints the words on
stdout. Rocky execs it in the tenant's own container. The command is Rocky's
setting (`ROCKY_TRANSCRIBE_COMMAND`, defaulting to
`["rocky-transcribe","{{MediaPath}}"]`), pinned by `WHISPER_VERSION` and
`WHISPER_MODEL` build args.

**Why:** Claude has no audio input modality, so without transcription a voice
note is silence. Doing it locally keeps a client's voice off any third-party
ASR service. Locally, on a 2-vCPU host with 3.7 GB of RAM and no swap, rules out
a Python/torch stack: whisper.cpp is C++, the quantised `base.en` model is about
60 MB on disk and roughly 250 MB resident while it runs.

The setting is Rocky's rather than OpenClaw's because the pinned OpenClaw has no
`audio.transcription` key and its config schema is strict — an unknown key makes
`openclaw config validate` fail and every tenant container refuse to start,
which is exactly how `cron.skipMissedJobs` took the fleet down on 2026-09-18.
Rocky is the process that runs the transcriber anyway, so Rocky holds the setting.

**Rejected alternatives:**
- *An ASR API (OpenAI, Groq, Deepgram).* Sends client voice to a third party,
  contradicting the tenant boundary the rest of the design maintains.
- *faster-whisper / openai-whisper.* Python, ctranslate2 or torch; several
  hundred MB resident per invocation on a box with about 1 GB free and no swap.
- *`audio.transcription.command` in `openclaw.json`.* Two sources of truth and a
  live schema risk, for no gain — OpenClaw never reads it in the pinned version.
- *Transcribing on the host instead of in the container.* One shared model load
  would be cheaper, but it puts a media decoder parsing untrusted user-supplied
  audio in the same process space as the vault and the router.

**Risks / edge cases found:**
- Every failure path is recorded as `[voice note: … — not transcribed]`. The
  agent is told transcription was unavailable and must say so rather than guess
  at the contents. Inventing words a client did not say is the worst outcome
  available here, so silence is loud.
- The wrapper must keep ffmpeg and whisper banner output off stdout, or the
  ledger records the banner as the user's words. `--no-prints`,
  `--no-timestamps`, and ffmpeg redirected to stderr; pinned by a test.
- `base.en` is English-only. Non-English voice notes will produce wrong text
  rather than nothing, which is worse than silence — a multilingual model is the
  open item if that appears in practice.
- Transcription is inline in the turn, so a long voice note is latency the user
  feels. Bounded by `ROCKY_TRANSCRIBE_TIMEOUT_MS` (120 s).
- Memory is the binding constraint, not disk. Concurrent transcriptions across
  several tenant containers on this host could exhaust RAM; the host tenant cap
  of 5 is what currently bounds it.

## 2026-09-20 Brand and naming rules live in the org skill

**Decision:** `org/skills/organization-context/SKILL.md` now carries the naming
rule (BugleRock — one word, no umlaut in text, the umlaut is logo artwork only),
the entity names, the tagline and the document defaults.

**Why:** The agent produced a client-facing teaser with "BügleRock branding
throughout" in the body copy. The rule existed only outside the system, so the
agent had no way to know it. The org skill is read-only, shared by every tenant
and already mounted, which makes it the one place a firm-wide rule belongs.

**Risks / edge cases found:**
- The skill is advisory context, not a filter. It reduces the error; it does not
  make the string unproducible.

## 2026-09-20 Docs are a feature suite, not a pile of phase specs

**Decision:** `docs/` is restructured around four living documents — `README.md`
(index and ground rules), `CODEBASE.md` (file-by-file map), `features/01..08`
(how each capability works: flow, boundary, failure modes) and this decision log
as the source of truth — plus `PATTERNS.md` and `backlog.md`. The phase specs
and plans were deleted once their content lived in `features/` and here. The
four surviving point-in-time documents carry a "Historical" banner. Two patterns
were added: **P11** (put an always-true rule where it is always read) and **P12**
(never extend a configuration whose schema you don't own).

**Why:** the specs described what we intended to build in a phase; nine days of
production found things no spec anticipated, so the specs had become a
confident, outdated second answer to every question. An engineer joining the
team reads the most specific document they can find, and a stale spec is more
specific than correct prose. Deleting them removes the wrong answer rather than
annotating it.

The split is by *lifetime*: the decision log is append-only and never rewritten,
the feature docs are rewritten whenever the code changes, and the codebase map
is mechanical. Each has one owner-event, which is the same discipline P1 applies
to state.

**Rejected alternatives:**
- *Update the phase specs in place.* They are organised by delivery phase, which
  is a fact about our calendar, not about the system. Nobody debugging media at
  02:00 wants to know which phase it shipped in.
- *One large ARCHITECTURE.md.* Everything is in it, so nothing is found in it,
  and every change touches the same file.
- *Generate docs from code.* Produces a second, worse `CODEBASE.md` and cannot
  record why a rejected alternative was rejected — which is most of the value
  here.

**Risks / edge cases found:**
- Code comments still cite phase-spec sections (`SPEC-phase3c` §1.4 and similar)
  and those files no longer exist. The section numbers remain meaningful because
  the same requirements are recorded here; `README.md` says so explicitly.
- The feature docs will drift, the same way the specs did. The mitigation is
  ground rule 2 — a capability ships with its feature doc in the same change —
  not good intentions.
- ~~The deleted specs are recoverable: `PLAN.md` from git, the rest from the copy
  on the production host.~~ **Wrong, corrected 2026-09-24.** Only `PLAN.md` was ever
  committed; `SPEC-phase3c*`, `PREFLIGHT-phase3c.md`, `HANDOFF-phase3b.md` and
  `BRIEF-phase3-onwards.md` have zero hits across all git refs. And `docs/` is not in
  `deploy/rsync-exclude.txt`, so `rsync --delete-after` removed the production copies
  on the first deploy after 2026-09-20. The content survives only in the code and the
  tests that carry the section numbers; it is written down as R1–R9.

## 2026-09-21 Guardrails are control-plane files, and the session key is ours

**Decision:** The product's rules live in a managed `ROCKY-GUARDRAILS` block that
Rocky writes into each tenant's `AGENTS.md` from a versioned template, verified
by a required onboarding step before the container serves traffic. The
BugleRock persona is a separate `ROCKY-PERSONA` block, seeded once so a custom
persona survives. A model never authors either. Separately, the OpenClaw
session key is derived from the `user` field Rocky already sends
(`agent:main:openresponses-user:rift-<addr>`), so `startNewSession()` begins a
new conversation by bumping a per-tenant epoch, and the agent gets
`start_new_session` as a real MCP tool. Model raised to Sonnet 5 at
`thinkingDefault: high`; the first-byte budget is its own 150 s constant and no
longer a symptom of an auth failure.

**Why:** OpenClaw injects those files into the **system prompt** — the cached,
authoritative position — while our rules were being prepended to every user
message, the weakest one. Every tenant was carrying 9.6 KB of stock OpenClaw
boilerplate there. Four production failures trace to that single inversion, and
a fifth (the phishing accusation) to Rocky speaking on the channel without its
words entering the model's session.

The guardrails are the safety mechanism, so the generator must not be
probabilistic. Deterministic templating gives a hash per tenant, a diff to
review, and an answer to "did tenant X have version N on date Z" that is a
lookup rather than a text-similarity judgement.

The session mechanism was found rather than built: the key is a pure function
of a string we already control, so a new session costs one integer and keeps
every prior transcript searchable.

**Rejected alternatives:**
- *A skill that writes the guardrails.* The generator and the safety artifact
  become the same probabilistic thing; the custom-persona track feeds user text
  into the step that writes the safety file; a dropped clause has no error path.
  Kept the skill for persona only.
- *Auto-invoking that skill at onboarding.* A skill invocation is a suggestion
  the model can skip — the exact failure class being fixed. The onboarding step
  cannot be skipped.
- *`metadata.openclaw.always` to force the skill.* Two OpenClaw doc pages
  contradict each other on whether it exists. Not a foundation.
- *`BOOTSTRAP.md` for setup.* It spends the user's first conversation on an
  interview and self-deletes on a heuristic. Fine for persona, unacceptable for
  files whose presence must be provable.
- *Shipping guardrails in the org bundle.* Guardrails are platform-universal;
  the bundle is BugleRock-specific and would not survive a public rollout.
  Guardrails moved to Rocky core, persona stayed in the bundle.
- *`/new` or `session.reset` for new sessions.* Reset is destructive and
  schedule-driven; the epoch keeps the old session readable.

**Risks / edge cases found:**
- Epoch 0 must render the historical key exactly, or every existing tenant
  silently loses its conversation on deploy. Pinned by a test.
- Activation first ran full container onboarding, which needed Docker and
  duplicated the gateway's own bring-up; it now owns the workspace only.
- Activation was fire-and-forget and leaked writes past test teardown. It is
  deduped and awaitable — two auth completions cannot race one tenant.
- `TOOLS.md` was never injected on the `claude-cli` path (it is a Codex
  concept). Deleted from the template, kept as skill reference material.
- `MEMORY.md` is absent because dreaming — its only writer — is not scheduled
  at all (`openclaw cron list` → none). Memory has never been enabled, and
  hibernation would have prevented the default 03:00 sweep regardless.
- Markers are HTML comments and are stripped from outbound text, or the agent
  would eventually echo one to a user.

## 2026-09-21 A media link must point where the file will be, not where it is

**Decision:** `deliverOutbox` moves a file into `outbox/sent/` first, then mints
the signed link for that final path, then sends. A send failure moves it back
so the next turn retries.

**Why:** Twilio accepts the message, returns 200, and fetches the media URL
afterwards. Moving the file once `sendMedia` resolved therefore guaranteed a
404 on every delivery — confirmed in the Caddy access log (three `404`s from
`TwilioProxy/1.1`) and as Twilio error 63019 on a `failed` message. Rocky logged
`delivered=1` three times while the user received nothing, because the API call
succeeding is not evidence the media was fetched.

**Rejected alternatives:**
- *Move on the status callback.* Correct in principle, but it needs a message
  SID → file correlation we do not keep, and it leaves the file in a mutable
  location during the window that matters.
- *Serve the file from both paths.* Two truths about where a file lives.
- *Never move the file.* Then delivered state has no record and the same file
  is resent on every turn.

**Risks / edge cases found:**
- Presence in `sent/` is now the delivery record, so a crash between the move
  and the send loses the retry. The window is one `await` and the file is still
  on disk for a human to find.
- This is the second failure of the same shape as the hallucinated sends: an
  API returning success is not proof the user received anything.

## 2026-09-21 The provider's limits are enforced in code and stated in the prompt

**Decision:** Two layers for every provider constraint. Replies are split at
1,600 characters inside the Twilio adapter (`chunkMessage`), `MEDIA:` markers
are parsed out of the reply and turned into deliveries
(`extractMediaMarkers`), and the content-type table covers 43 types with a
`text/plain` fallback for anything human-readable. The same three facts are
stated in the managed guardrail block as `<length>` and `<attachments>`. The
agent is also told never to name the model or provider it runs on.

**Why:** a prompt alone is a request the model can ignore, and code alone lets
the model walk into the failure every turn and be rescued silently. Stating it
in both places means the common case never arises and the rare one is handled.

The length bug was invisible for the same reason the media bug was: the send
API returns success and the provider rejects afterwards. A 3,327-character
reply — the exact content the user had asked for — was recorded as delivered
and never arrived, while the agent insisted it had sent it. The error code was
in our own ledger the whole time.

**Where it is enforced:** `maxBodyChars` is a declared capability on the
adapter, and `enforceBodyLimit()` wraps the channel at the port. Putting it in
the Twilio class worked only because Twilio happens to be the live adapter; at
the port it is structural, so a future Meta or Baileys adapter declares its own
number and cannot silently skip the split. Media is deliberately not wrapped.

**Rejected alternatives:**
- *Chunking in the router.* The limit is the provider's, not the product's.
- *Chunking inside each adapter.* Correct today, forgettable tomorrow.
- *Truncating long replies.* Silently losing the end of an answer is worse than
  two messages.
- *Teaching the model to split its own replies.* It tried exactly that and
  narrated it ("I can only send one message per turn"), which is both wrong and
  noise. The prompt now says to send a file instead.
- *Stripping `MEDIA:` and discarding it.* The model was trying to attach
  something real; honouring the intent is strictly better than deleting it.

**Risks / edge cases found:**
- Committed bytes and sent bytes stay equal only as a concatenation of parts;
  the ledger holds one row for a reply that may leave as several messages.
- A single word longer than the limit is hard-cut. No natural boundary exists.
- `text/plain` for `.md`/`.yaml`/`.log` is a rendering choice, not a claim about
  the file's real type.
## 2026-09-21 Product identity is Rocky

**Decision:** source, packages, runtime identities and deployment templates use
Rocky. `ROCKY_*` is authoritative; `RIFT_*` is a warning fallback until the
production environment is switched and verified. Workspace readers accept the
old markers during the same migration window, while writers emit `ROCKY-*`.

Three old values remain by design: `_riftVault` and `rift-vault:v1` are the
encrypted-record wire format, `rift-<phone>` is the persisted OpenClaw session
identity, and the naming guardrail names Rift only to prohibit exposing it.
Production infrastructure is migrated separately with
`docs/ROCKY-PRODUCTION-CUTOVER.md`.

## 2026-09-21 The connector database keeps its name, like the other wire identities

**Decision:** The Compose stack keeps `rift_connector` as the database name,
role and default password, and the live project stays `rift` (so the volume
`rift_connector-postgres-data` is reused). `scripts/compose.mjs` pins the
project name and works with either the `docker compose` plugin or the
standalone `docker-compose` binary.

**Why:** the same reasoning already applied to `_riftVault`, `rift-vault:v1`
and the `rift-<phone>` session key — a persisted identifier is a wire format,
not branding. Renaming it here is worse than elsewhere: `ALTER ROLE … RENAME`
cannot rename the session user, and the only superuser on that instance *is*
`rift_connector`, so it needs a temporary superuser; if the stored verifier
were md5 rather than scram the password would break with the rename. All of
that risk buys nothing a user can see.

Found the hard way during the cutover: the renamed compose file declared
`rocky_connector` while the live database was `rift_connector`, so recreating
the connector would have pointed it at a database that does not exist.

**Rejected alternatives:**
- *Rename the database and role in place.* Needs a temporary superuser on a
  live instance holding every tenant's connector state.
- *Dump and restore into a renamed database.* A data migration for a name.
- *Copy the volume.* The largest failure mode in the cutover, for a label.

**Risks / edge cases found:**
- The assertion issuer (`rocky-connector-control-plane`) *was* renamed on both
  sides, so the gateway and a sidecar running old code reject each other with
  "Malformed connector service assertion". Both must be deployed together —
  the sidecar is not independently versioned.
- `scripts/compose.mjs` hardcoded `docker compose`, which does not exist on the
  production host. Any documented `npm run docker:connector:*` would have
  failed there.

## 2026-09-21 Deliverable media types are a provider capability, enforced before the send

**Decision:** `mediaTypes` joins `maxBodyChars` as a declared capability on the
channel adapter — for WhatsApp, the set Twilio documents as accepted (PDF, DOC,
DOCX, PPTX, XLSX, JPEG, PNG, WEBP, OGG/AMR/3GP/AAC/MPEG audio, MP4, vCard).
`deliverOutbox` checks each file against it, moves a refused file to
`outbox/undeliverable/`, and the router tells the user in plain words that the
type cannot be sent and offers a PDF. The guardrail block names the deliverable
formats so the agent writes a PDF in the first place.

**Why:** `text/plain` is not an accepted WhatsApp document type
(https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages). Twilio
accepted the message, fetched the URL with `200`, recorded the text as `read`,
and WhatsApp dropped the attachment before the user ever saw it. Rift logged
`delivered=1`, the agent believed it had sent the file, and the user had nothing
— three times for the same file.

An earlier change had made this worse on purpose: unknown readable extensions
were mapped to `text/plain` "so the provider renders it rather than rejecting an
unclassifiable octet-stream". The provider rejects `text/plain` just as hard,
so that mapping converted one silent failure into a broader one.

**Rejected alternatives:**
- *Rename the file to an accepted extension.* Twilio validates the
  `content-type` header against the file, so this fails and lies twice.
- *Auto-convert to PDF in the gateway.* Needs a document toolchain in the
  control plane; the agent already has document skills in its container, and the
  prompt now tells it which formats reach the user.
- *Leave the file in the outbox and retry.* Retries a send that can never
  succeed, on every subsequent turn.

**Risks / edge cases found:**
- A provider with no declared list stays unrestricted, so the mock and Baileys
  channels are unaffected.
- The refusal notice is a second message after the reply. The reply is already
  committed, so a notice failure cannot cost the answer.
- Image limit is 5 MB against 20 MB for other media; not yet enforced.

## 2026-09-21 A session boundary, and a file the agent sends is a real message

**Decision:** `startNewSession` records `sessionFromSequence` alongside the
epoch, and transcript replay, the related-context lane and its keyword search
all refuse to read past it. Separately, `deliverOutbox` records every delivered
file as an outbound message carrying the provider's id, so a user replying to a
file resolves. The quoted-reply preamble no longer offers a reason when a quote
is missing. `tenant user deprovision` removes a tenant: dry-run by default,
index entries first, then the container, then the directory moved to
`tenants/.deprovisioned/`.

**Why:** three separate failures, one shape — the record disagreeing with what
the user sees.

*Sessions.* `start_new_session` bumped the key, but replay pulls the last 20
messages of the conversation regardless, so a cold container after a reset
re-injects the conversation just ended. The feature was correct only while the
container stayed warm — it would have looked fine in testing and broken after a
hibernation cycle.

*Quoted replies.* A user replied to a PDF the agent had sent and got "the
message you're replying to isn't in what I can see". Media sends bypass
`deliverResponse`, so their provider id was never stored: 195 outbound rows had
one, 6 did not, and the quoted `MM…` id was not in the table at all. Worse, our
own preamble told the model the reason was the provider's 7-day window, so it
confidently explained a cause that did not apply. We do not know why a quote is
missing, so the preamble now says only that it is missing.

*Deprovision.* Removing a tenant was a hand-edit of two files that must agree.
The index pointing at a missing directory errors on every message instead of
letting the sender onboard again, so the order is now index → container →
directory, and the directory is archived rather than deleted.

**Rejected alternatives:**
- *A migration adding `session_epoch` to every message.* The boundary is one
  integer per conversation and conversation id is the tenant id; the tenant
  record already owns session identity, so a schema change buys nothing.
- *Scoping the explicit `search` command too.* An operator searching the
  transcript wants everything. Only the auto-injected lane is scoped.
- *Keeping a checkpoint across the boundary.* A summary of the ended
  conversation is exactly what must not come back.
- *Deleting the tenant directory outright.* In a regulated system, recovering
  an operator mistake must not depend on a backup taken beforehand.

**Risks / edge cases found:**
- `sessionFromSequence` is read from the tenant record on every turn, so a
  tenant record that fails to save leaves the boundary unenforced; the write is
  part of `startNewSession` and its failure surfaces there.
- Older tenants have no boundary (`0`), which means the whole transcript — the
  correct behaviour for a tenant that never reset.
- Media rows are `[file sent: name]`, so keyword search finds the filename but
  not the file's contents.

## 2026-09-21 A quoted reply replays its neighbourhood; the turn carries only turn facts

**Decision:** When a quoted reply resolves, the prompt now includes the messages
around it — `QUOTE_BEFORE` (6) earlier and `QUOTE_AFTER` (4) later, roughly
three exchanges before and two after — rendered with the quote marked `>>>`.
At the same time the turn preamble was cut back to per-turn facts only:
`audiencePreamble()`, `relatedContext()`, `needsDisambiguation()` and
`searchTerms()` are deleted. `turn-context.mjs` went from 181 lines and seven
exports to 101 lines and three.

**Why:** a quote on its own is a sentence without its thread, so the agent
answered the sentence. Replaying what surrounded it makes the reply gesture a
real pointer into the transcript rather than a single decrypted row.

The removals are the other half of the same idea. The standing rules moved into
the managed guardrail block, which OpenClaw injects into the **system prompt**;
repeating them in every user message cost ~1.2 KB per turn and put them in the
weaker position. `relatedContext` was word-count heuristics
(≤3 words, or a referent under 25 characters) firing a keyword search to offer
the model candidates — a guess at what the user meant, where the quote
neighbourhood is the actual answer when a quote exists and the model's own
history is better when it does not.

**Rejected alternatives:**
- *Replaying the whole conversation around a quote.* Unbounded, and it competes
  with the cold-start replay for the same context budget.
- *Keeping `relatedContext` as a fallback when no quote exists.* It fired on
  short messages, which is most WhatsApp traffic, and injected candidates the
  model had not asked for.
- *Leaving `audiencePreamble` in place "for safety".* Two copies of a rule is
  two things to keep in step, and the copy in the weaker position is the one
  that would drift.

**Risks / edge cases found:**
- The neighbourhood is bounded by `sessionFromSequence`, so a quote near a
  session boundary cannot drag the ended conversation back.
- The quote itself is excluded from the surrounding list, or it would appear
  twice.
- Removing the audience preamble makes the managed guardrail block load-bearing:
  a tenant whose `AGENTS.md` lost its block now has *no* audience rule, which is
  why the onboarding step that rewrites it is required rather than advisory.

## 2026-09-21 eslint replaces the bespoke undefined-identifier test

**Decision:** `eslint` 9 with `no-undef` as an error, wired as `pretest` so
`npm test` cannot pass while an undefined identifier exists. The hand-written
`no-undefined-identifiers` test stays for the module-level case it does cover.

**Why:** that test passed while **four** `ReferenceError`s existed in `src/`,
three of which shipped: `OPENCLAW_GATEWAY_IDLE_MS` reached a user,
`to is not defined` broke every turn, `enforceBodyLimit is not defined`
crash-looped the gateway 626 times, and eslint immediately found a fourth —
`assertPinnedSpawnRuntime()` called in `spawnGateway()` without an import, live
on the spawn path. A scanner that only reads module scope advertises a guarantee
it does not provide.

Proven rather than assumed: removing that import makes `npm test` fail on
`no-undef` before a single test runs.

**Rejected alternatives:**
- *Extending the bespoke scanner to function scope.* That is writing a linter.
- *Lint as a separate CI step.* The failures happened on a laptop minutes before
  a deploy; the gate has to be in front of `npm test`.

**Risks / edge cases found:**
- The globals list is explicit, so a genuine Node global missing from it reads
  as an error — `queueMicrotask` and `performance` had to be added.
- 18 `no-unused-vars` warnings remain, deliberately warnings: they are dead
  imports in tests, not defects.

## 2026-09-21 Local transcription removed; speech-to-text becomes a cloud provider

**Decision:** whisper.cpp, ffmpeg, the model and the `rocky-transcribe` wrapper
are removed from the tenant image, and `tenant-transcribe.mjs` is deleted.
`src/transcription.mjs` is the single seam a cloud provider (Sarvam) plugs
into. Until it is wired, `transcribeAudio()` returns null and a voice note is
recorded as untranscribed — the agent is told and must say so. **There is no
local fallback**, by instruction.

**Why:** two reasons, and the second is the one that decided it.

*Quality.* `base.en` is English-only and produced confidently wrong text on
Hindi and Kannada voice notes. Wrong words attributed to a client are worse
than no transcript, and this is an Indian firm — the wrong-language case is the
common case, not the edge.

*Capacity.* Transcription cost ~250 MB resident and both cores of a 2-vCPU host
per voice note. It was the single largest term in the memory budget and the
reason turn concurrency had to be capped at 2. Removing it takes the host from
4 warm tenants to 5 and lets concurrency rise to 3.

This reverses the 2026-09-20 decision, whose reasoning was confidentiality:
local transcription meant a client's voice never left the host. That property is
now gone. Sarvam is an Indian provider, which helps SEBI residency, but a
client's audio still reaches a third party and MAS-side clients are not covered
by that. Before any client audio flows it needs a retention term and the same
explicit user warning agreed for BYO MCP.

**Rejected alternatives:**
- *Cloud first, local fallback.* Keeps whisper in the image, so the memory and
  CPU budget must still reserve for the spike and none of the capacity is
  recovered. A fallback that costs the whole saving is not a fallback.
- *A multilingual local model.* `medium` is ~1.5 GB resident on a host with
  1.8 GB free. Not available.
- *Leaving a stub that pretends to transcribe.* Inventing words a client did not
  say is the worst outcome in this system.

**Risks / edge cases found:**
- Voice notes do not work at all until Sarvam is wired. Chosen deliberately.
- ffmpeg went with it, so nothing in the container converts audio any more; a
  cloud provider must accept OGG/Opus directly or conversion returns host-side.
- `ROCKY_TRANSCRIBE_COMMAND` and `ROCKY_TRANSCRIBE_TIMEOUT_MS` no longer exist.
  They are not read anywhere, so a stale value in an env file is inert.

## 2026-09-21 Capacity is a policy, not a wall

**Decision:** `MAX_TENANTS_PER_HOST` no longer refuses. `src/openclaw/admission.mjs`
decides: a free slot admits; a cron container yields; a person's idle container
yields when it is *overdue* against that tenant's own p75 inbound gap
(`src/tenant-data/rhythm.mjs`); otherwise the arrival waits up to 45 s for a
turn to finish; otherwise the least-bad idle slot is taken; only when every
slot is busy or younger than 60 s is anyone refused. Nothing with
`inFlight > 0` is ever touched. Provisioning no longer consults the ceiling,
and `yieldSlotForInteractive()` is gone — admission is the single owner of
stop-for-capacity. Full design in `docs/features/10-admission-and-eviction.md`.

**Why not LRU, which is what was asked for:** the traffic disproves it. 94.6%
of inbound messages arrive within 20 minutes of the previous one, p50 gap 54 s,
p75 137 s — so on this workload *recency predicts return*, and LRU would evict
the tenant most likely to speak next, turning a 2.3 s resume into a 24 s cold
start for exactly that person. FaaSCache (ASPLOS '21) exists for this reason:
recency-only eviction ignores restore cost. Scoring against each tenant's own
rhythm distinguishes a tenant idle 3 minutes whose p75 is 137 s (overdue) from
one idle 10 minutes whose p75 is half an hour (not).

Borrowed deliberately: idle-only candidates and never-evict-busy from FaaSCache
and Agones; minimum residency instead of a cooldown from Knative's
`scale-to-zero-pod-retention-period`; priority bands where same-band work does
not preempt itself from Borg; queue-then-shed from Lambda's sync/async split.
Kubernetes node-pressure eviction was studied and rejected as a model — it
ignores grace periods and disruption budgets because it is an OOM defence.

**Rejected alternatives:**
- *Plain LRU.* Disproven above.
- *A cooldown between evictions.* The 60 s residency floor already bounds the
  rate; a second knob deciding the same thing is how three mechanisms came to
  own hibernation in the first place.
- *Refusing instead of waiting.* A turn takes ~25 s, so when every container is
  busy a short wait usually beats a refusal outright.
- *Keeping the ceiling at provisioning.* Its comment cited always-on runtimes, a
  premise reversed when hibernation landed on 2026-09-18.

**Risks / edge cases found, by testing on real containers:**
- **Evicting a cron container silently dropped its job.** The old
  `yieldSlotForInteractive` re-queued the run at the head; a plain `stop()` did
  not. Admission now calls `requeueEvictedCronWake()` first. The test I was
  about to delete as redundant is what caught this.
- **`overdue` must not gate a cron victim.** It measures a person's rhythm, and
  a cron container serves no one; the first live run spared a cron container and
  took a person's.
- **Containers surviving a restart were invisible to the pool.** A known
  tenant's running container was neither adopted nor stopped, so the host ran
  `max + orphans` — measured at 6 containers while admission believed 5, with
  available memory down to 818 MB. `adoptRunningContainer()` now takes them back
  (or removes them when their port is dead).
- The pool is process memory, so this is single-host by construction. A second
  gateway would believe it owned the same slots.

## 2026-09-21 A tenant audit never resurrects its tenant

**Decision:** `appendTenantAudit()` writes only when the tenant directory
already exists, and `user deprovision` records to the platform audit instead.

**Why:** deprovision archived a tenant directory and its own audit line
recreated it **3 ms later**, leaving a stray directory holding nothing but
`audit.jsonl`. Beyond the litter, a deprovision record inside the tenant's own
audit file is archived with the tenant — so "who removed this, and when" is
unanswerable exactly when it matters. A record about a tenant that no longer
exists belongs where it outlives them.

**Risks / edge cases found:**
- Any caller auditing a tenant mid-deletion now writes nothing to the tenant
  file. That is the intent, and the platform audit still has the record.

## 2026-09-22 Session control is a CLI resource, not a bespoke MCP tool

**Decision:** `start_new_session` stops being hand-written logic inside
`agent-mcp.mjs` and becomes a `session` resource in the tenant CLI
(`session new --tenant <id>`), reached through `executeTenantRequest` like every
other capability. The MCP tool, if kept, becomes a one-line passthrough to the
resource — the same shape the four Composio tools already have.

**Why:** starting a session is an internal control-plane operation on tenant
state. Today it calls `startNewSession(ctx.tenantId)` directly, so it is the one
agent capability with **no resource definition, no `agentActions` gate, and no
audit entry** — the grant model in `authorization.mjs` cannot see it at all.
`send_file_to_user` has the same shape and grew its own parallel guard
(`needs: ['channel','recipient']`), which is the second source of truth the
no-patchwork rule exists to prevent. Everything the agent can do must be
expressible, and denyable, in one place.

**Rejected alternatives:**
- Leave it as an MCP tool and add a grant check inside it — that is the second
  authorization mechanism, not a fix for it.
- Expect the CLI surface to be measurably faster for the agent. It is not: the
  epoch lives on the host, the agent lives in a container, so either surface is
  one hop over the Docker bridge. The reason to move it is the pipeline, not
  latency, and a bash spawn is strictly more overhead than an MCP call.

**Risks / edge cases found:**
- `sessionUserFor()` and `sessionFromSequence` do not change. Only the caller
  and the authorization path do.
- Whatever surface the agent ends up with, `startNewSession` must stay the only
  writer of `sessionEpoch`.

## 2026-09-22 The MCP projection must be byte-stable across a wake

**Decision:** `prepareTenantComposioRuntime` derives the projection purely from
persisted state and writes only when the bytes differ, instead of the current
unconditional `fs.rm` and rewrite. Projection preparation becomes an explicit
step of the WAKE phase rather than a `required: false` repair.

**Why:** OpenClaw invalidates the underlying Claude CLI session whenever the MCP
server map changes (`resolveCliSessionReuse`, reason `mcp`). Measured on
`br_f253fafe2f46`: **30 invalidations, every one `invalidated:mcp`**, one per
container, up to 2026-09-21T13:29. It stopped only because the Composio sidecar
fixes happened to stabilise the stored tool-router endpoint — nothing enforces
it. OpenClaw normalises only its own loopback port
(`normalizeOpenClawLoopbackUrl`); every other byte we hand it must be identical
or the user's conversation restarts underneath them.

**Risks / edge cases found:**
- `docker/openclaw/entrypoint.sh` reads `/run/rocky-input/composio.json` while
  the live mount — and `CONTAINER_MCP_PROJECTION` — is `/run/rift-input/...`.
  The entrypoint swallows `ENOENT`, so the next image rebuild starts a container
  with **no Composio and no Rocky tools, silently**, and resets the session as a
  side effect. This mismatch is the reason the invariant needs a check and not
  just a careful writer.
- A Composio tool-router session that legitimately rotates server-side is an
  unavoidable reset. It must be logged as such, not diagnosed a second time.

## 2026-09-22 Replayed history names the speaker in the third person

**Decision:** `assembleContext()` and `quotedReplyPreamble()` both render an
outbound message as `Model response:`, never `You:`, through one shared
`src/tenant-data/transcript-label.mjs`. The `<provenance>` guardrail is corrected
to say platform messages **do** appear in replayed history rather than that they
"never enter your memory".

**Why:** `direction` is a transport fact and was being used as an authorship
fact. The thread has two authors — the model, and Rocky for the ~25 deterministic
replies produced before the model runs (the OAuth link, activation notices, every
error string). `createDeferredChannel` commits all of them as one
`direction='outbound'` row, so every one replayed as something the model said.

Measured consequence: a tenant asked about the Claude login link Rocky had sent
them. The model was shown that link attributed to itself, found no tool call that
produced it, correctly applied the honesty guardrail, and told the user their own
platform's message was an account-takeover attempt. The guardrail was working; the
input was false. The guardrail then made it worse by asserting these messages never
reach memory, which left forgery as the only explanation consistent with what the
agent could see.

**Rejected alternatives:**
- An `author` column on `messages` plus a renderer change. It is the more precise
  fix and remains the upgrade path if machine-verifiable provenance is ever needed,
  but it is a schema migration to correct a label that was simply wrong.
- One-author: have Rocky hand the model the link to deliver in its own words. It
  removes the ambiguity entirely, but a model can mangle a URL it is asked to
  repeat, and the login link is the one message that bootstraps everything else.

**Risks / edge cases found:**
- Two renderers carried the identical expression; `turn-context.mjs:41` was not in
  the original scope. They now share one function, and a test asserts neither
  inlines a label again.
- `Model response:` is 11 characters longer than `You:` per outbound line, so the
  6000-char replay budget holds slightly less. Accepted; not yet re-tuned.
- `saveCheckpoint()` has no production caller, so no stored summary carries the old
  label. A future summariser must emit the new one.
- Editing `org/templates/workspace/AGENTS.md` fails provisioning until
  `org build` reruns — the bundle is checksummed. Bundle is now `2026.09.22-rocky.6`.
- The mirror defect is untouched: replies sent on the real channel after the turn
  commits (media-type refusals, activation readiness) are never persisted, so the
  agent cannot see them at all. Logged, not fixed.

## 2026-09-22 The wire identities become Rocky, with real migrations

**Decision:** supersedes "2026-09-21 Product identity is Rocky" (`:1236-1239`) and
"The connector database keeps its name" (`:1243-1266`). The user's call, 2026-09-22:
consistency before onboarding begins, while the only live conversation is their own.
Three renames, each with a migration rather than a find-and-replace.

**1. Vault envelope v1 → v2.** `rocky-vault:v2:` is the AAD and `_rockyVault` the
discriminator. `envelopeVersion()` derives both from the envelope itself, so
`ENVELOPE_VERSION` no longer serves three coupled purposes — the AAD prefix, the
discriminator check and the write version were one constant, and a v2 that reads v1
cannot share them. `vault migrate-envelopes --tenant <id>` re-seals every record;
`--dry-run` reports without writing, and a second run is a no-op.

Scope correction: this is **not** three vault files. `tenant-data/store.mjs:23` seals
every message body under the same envelope with record name `transcript`, so
`messages.body_cipher` and `context_checkpoints.summary_cipher` migrate too. The
earlier "3 records, cheap" estimate was wrong — it counted only `tenants/*/vault/*.json`
and missed that the transcript shares the primitive. `features/02-tenant-isolation.md`
documented only the vault use, which is how the estimate went wrong.

**2. OpenClaw session key `rift-` → `rocky-`.** Both sites move together —
`tenant-session.mjs:7` and the independent fallback at `tenant-openclaw.mjs:627`.
Renaming one would give a tenant two different sessions depending on call path, and
the existing test asserts that line's shape but not its literal.

**3. Legacy guardrail markers.** `legacyTags` stops being a permanent alias and becomes
a one-time in-place rename. The old behaviour left an unmanaged `RIFT-PERSONA` block
alone forever; a plain deletion of the alias would have overwritten a user's persona
with the default template, because `SOUL.md` is `managed: false` and the block would no
longer be found. Renaming the marker preserves the content and terminates the shim.

**Rejected alternatives:**
- Keep them as permanent wire identities. That was the previous decision and it was
  right while the cost of changing was a live conversation; it stops being right when
  the only conversation is the operator's own and a team is about to inherit the code.
- Rewrite OpenClaw's `sessions.json` to carry the old sessions across. P8 — it is their
  internal state. The cutover is a one-time reset instead.

**Risks / edge cases found:**
- SQL in `src/privacy/` was rejected by `test/gateway-supervision.test.mjs:182`. The
  migration is split: transcript rows in `tenant-data/envelope-migration.mjs`, vault
  files in `privacy/envelope-migration.mjs`.
- v1 read support must stay until every deployment reports zero v1 records. Dropping it
  early makes a half-migrated tenant unrecoverable.
- The session-key cutover loses the live OpenClaw session. Our transcript is untouched,
  so `contextNeeded()` replays the bounded window — a visible restart, not amnesia.
- `sessionEpoch` is **not** bumped by the prefix change, so nothing in the tenant record
  records that it happened. It is an operator step, not a self-describing one.
- `docker-compose.yml:24` healthchecked `rocky_connector` while `:18-19` created
  `rift_connector`, so a fresh volume could never become healthy and `composio-connector`
  (`condition: service_healthy`) would never start. Fixed to match the live database as a
  standalone change — **the compose identity itself must not be renamed until the
  database migration runs with it**, which is the exact incident recorded at `:1258-1260`.

## 2026-09-22 The MCP projection is written only when it changes

**Decision:** `prepareTenantComposioRuntime` compares before writing, `chmod`s
unconditionally, and returns `{serversHash, rewrote}`. A missing Docker bridge
address is now fatal. `detectBridgeGateway()` memoises its first success.

**Why:** three separate causes, only one of which was in the original framing.

1. The projection was rewritten on **every turn**, not every bring-up —
   `resolveOpenclawRunContext` calls `hydrateMcp` and runs from `runOpenclawTurn`.
2. `fs.rm` + `fs.writeFile` always allocate a **new inode**. A running container's
   bind mount holds the old, deleted one. Byte-equality does not fix that; only not
   writing does. That is what the change actually buys.
3. `detectBridgeGateway()` shelled out to `docker network inspect` on every call and
   returned `null` on any failure, whereupon the whole `rocky` server was dropped from
   the map and reappeared next turn. That is a *membership* change, worse than a byte
   change and intermittent by construction.

**Rejected alternatives:**
- Move projection preparation out of the turn path into the WAKE phase, as the spec
  proposed. Once the write is conditional the per-turn call is a read and a compare
  with no write, so the move buys nothing — and `resolveOpenclawRunContext` returns
  `configPath` from it, which the spawn runtime needs. Removing it would have risked
  the spawn path for no measurable gain.
- Log a warning and emit a projection without `rocky`, as before. A projection missing
  the control plane is not degraded, it is a different capability set: the agent
  silently loses every Rocky tool and the session resets. Refusing the turn is louder
  and recoverable.

**Risks / edge cases found:**
- `chmod` must run even when the bytes match. `mode:` on `writeFile` is umask-masked at
  create and a no-op on an existing file, so an early return would never repair a
  pre-existing `0644`.
- The memoised bridge address is process-lifetime. A Docker daemon that restarts with a
  different bridge subnet needs a gateway restart; `resetBridgeGatewayCache()` exists
  for tests and would be the seam if that ever becomes real.
- Unavoidable and out of our hands: `sync` calls Composio `sessions.create`, which mints
  a new tool-router URL, and `sync --pending-only` runs on every turn from
  `agent.mjs:48`. Its guard skips only when a record exists, `endpoint` is truthy and no
  connection is `INITIALIZING`/`INITIATED` — so a tenant with a pending connect gets a
  new URL, and a session reset, on every turn until it settles.

## 2026-09-22 Four guarantees that were built and never connected

**Decision:** wire them, rather than delete them as dead code. A dead-code sweep
found each one; none were detritus, all were load-bearing machinery with no caller.

1. **Committed replies are re-sent at boot.** `resendCommittedResponses` existed,
   documented "Run at boot, after recovery", with zero callers. `index.mjs` now calls
   `resendAllCommittedResponses(channel)` after `recoverAllTenantLanes`. Lane recovery
   only handles `QUEUED`/`CLAIMED`; a turn in `RESPONSE_SAVED` has its bytes committed
   and needs re-sending, not re-running. Persist-before-send exists precisely so that
   is possible, and the step that made it possible was never called.
2. **Supervision supervises something.** `superviseTenant`/`unsuperviseTenant` had no
   production caller, so the 15-second sweep iterated an empty Set forever. Now bound
   to the pool lifecycle: supervised on start and on adoption, unsupervised inside
   `stopTenantGateway`. Deliberate stops — hibernation and eviction both route through
   it — therefore stay down, while an unexpected death is restarted by the host.
3. **The generation counter survives a gateway restart.** `dockerRunGateway` now
   persists `generation`, and `seedGeneration()` lifts the in-memory counter to the
   persisted value on every meta read. The comment at the counter claimed it
   "deliberately outlives pool entries"; it was a `Map` in process memory, so it did
   not outlive the process. Both the counter and the adopt path could hand out
   generation 1 after a restart, which is exactly the stale-reply the fence exists to
   reject.
4. **CI runs a supported Node.** The workflow pinned 20 against `engines >=22.14`.

**Rejected alternatives:**
- Delete the supervisor as superseded by hibernation. Its own comment states the real
  reason it exists: Docker's restart policies must not be used, because a restart the
  host does not observe leaves the generation counter stale. That is still true.
- Make `nextGeneration` async so it could read the meta directly. It is called on
  every start path; seeding on the reads we already perform is the same guarantee
  without making a hot path await the filesystem.

**Risks / edge cases found:**
- Supervision now interacts with admission. Eviction calls `stopTenantGateway`, which
  unsupervises, so a container evicted to stay under the host ceiling is not
  resurrected. If a future eviction path bypasses that function it will fight
  admission for memory.
- `README.md` told operators to set `ROCKY_OPENCLAW_IMAGE=rocky-openclaw:local` in
  four places while `npm run docker:build:openclaw` builds `rocky-openclaw:2026.7.1-2`.
  Harmless when it was written; with `assertImageContract()` it is now a documented
  route to a fleet-wide outage, because no container can be created from an image that
  does not exist. Corrected.

## 2026-09-22 Baileys is removed; Twilio is the only WhatsApp transport

**Decision:** `src/baileys-channel.mjs` and its dependencies go. `ROCKY_CHANNEL`
defaults to `twilio`, and an unknown channel now throws instead of falling back to
mock.

**Why:** production has run `ROCKY_CHANNEL=twilio` throughout. Baileys was still the
*default*, so an operator who forgot the variable got an unpaired WhatsApp-web client
instead of a clear failure. It carried six npm dependencies — `@whiskeysockets/baileys`,
`@hapi/boom`, `pino`, `qrcode`, `libsignal` and a vendored no-op eslint stub existing
only to stop npm resolving a git-URL config — plus an auth-lock path in `scripts/start.mjs`
and a logout alert in `ops-alert.mjs`.

**Rejected alternatives:**
- Keep it as a fallback transport. A fallback nobody exercises is not a fallback; its
  three tests asserted `assert.ok(true, 'skipped: …')` whenever a gateway held the lock,
  so they reported green while asserting nothing.

**Risks / edge cases found:**
- Failing loud is a behaviour change: a dev without Twilio credentials now cannot boot,
  where before they silently got mock. That is the intent.
- `summarizeDisconnect` and `postLogoutWebhook` are kept — Twilio can lose a connection
  too, and they are exercised independently. Only the Baileys-branded wrapper went.

## 2026-09-23 The MCP projection is a bind-mount source, so its lifetime is owned, not incidental

**Decision:** `prepareTenantComposioRuntime` no longer deletes the tenant runtime
directory when the Composio endpoint is absent. It writes a projection containing
whatever servers do exist — `rocky` always, `composio` only when an endpoint is
configured. `dockerStartContainer` now verifies every recorded bind source before
handing control to Docker, and `containerMountsIntact` asserts the projection path
unconditionally rather than only when the derived spec happens to list it.

**Why:** Docker materialises a missing bind source instead of failing, and for a file
mount it creates a **root-owned directory**. The container then fails with
`OCI runtime create failed: … not a directory` (exit 127) on every subsequent start,
and the gateway cannot repair it, because unlink permission comes from the parent —
which Docker also created as root. This took tenant `br_f253fafe2f46` down twice; the
second outage lasted from 12:53 to 14:09 UTC on 2026-09-23. The deletion was the
root cause: `fs.rm(directory, { recursive: true, force: true })` removed a path a
stopped container still had bound.

A second, quieter defect fell out of the same reading: with no endpoint the old code
returned before building `servers`, so a tenant without Composio silently lost the
`rocky` agent MCP server too.

**Rejected alternatives:**
- *Repair the root-owned directory when found.* The gateway runs as `ubuntu` and
  cannot unlink it. A repair path would need `sudo`, which is a larger privilege than
  anything else in the gateway, to paper over a deletion we control.
- *Make `ensureRegularFile` handle it.* It already replaces a non-file at the
  projection path, but only when the process can unlink it — which is exactly the case
  that fails. Fixing the symptom at the writer cannot reach the cause.
- *Keep the mount conditional and rely on `containerMountsIntact` alone.* Detection
  without prevention still leaves the poisoned tree behind on the create path, where
  `docker run` auto-creates just as readily as `docker start`.

**Risks / edge cases found:**
- `tenantMountSpec` derives the projection mount from `fs.existsSync` at call time,
  while the container's mount set is frozen at `docker run`. The two can disagree.
  Not deleting the file removes the practical cause; the residual TOCTOU window is
  one tick inside `dockerRunGateway` and is now the only one left.
- Every tenant that has been hydrated now always has a projection, so the mount is
  stable rather than flickering. A never-hydrated tenant still has no projection
  mount, which is correct.
- `dockerStartContainer` refusing to start is a behaviour change: a tenant with a
  genuinely missing mount now fails loudly at wake instead of being wedged
  irreversibly. The caller already handles a failed wake by recreating the container.

## 2026-09-23 The Bot control plane is Rocky's, not OpenClaw's

**Decision:** OpenClaw stays what it already is for us — a per-tenant Claude CLI
runner. The Bot-agent control plane (run states, leases, approvals, triggers)
lives in Rocky beside the durable turn ledger. Native `agents`, `subagents`,
`cron`, `memory` and `approvals` are ruled out as load-bearing components.
Evidence: `docs/research/2026-09-23-openclaw-openmuse-findings.md`.

Five consequences, each approved:
1. **Work-shaped run states.** `TURN_STATE` is delivery-shaped; add
   `WAITING_SUBRUN`, `AWAITING_APPROVAL`, `RETRY_WAIT`.
2. **A lease table**, subsuming the durable run record, dedupe and eviction
   protection.
3. **Approval as a first-class persisted state**, carrying a hash of the exact
   payload shown to the approver — see rule 3 in `docs/PATTERNS-durable-work.md`.
4. **Class A Bots first** — named roles inside the tenant's existing container.
   Class B (own container) deferred until a task genuinely runs for hours.
5. **Cron becomes a trigger that enqueues a leased run**, never an executor.

**Why:** the decisive finding is cross-agent OAuth read-through
(`concepts/multi-agent.md:32`): when a secondary agent's credential expires or
refresh fails, OpenClaw adopts the main agent's credential for the same profile
automatically, with no operator action. A Bot scoped to one account loses that
scope precisely when its own token lapses, so the isolation boundary we need does
not exist where we need it. Reinforced by: workspace is not a sandbox (`:38`);
WhatsApp DM access control is global per account (`:197`); per-agent subagent
limits are rejected by a `.strict()` schema so an untrusted Bot cannot be
constrained more than the fleet; and all run, audit, cron and approval state
shares one SQLite file across agents.

Independently: exec approvals are **off** in our live deployment
(`DEFAULT_ASK="off"`, no `tools`/`approvals`/`diagnostics` block, zero rows in
`exec_approvals_config`), approval decisions are never persisted anywhere, and
the vendor's own scorecard puts the project at 68% — their Alpha band — with 2%
QA coverage on automation and 0% on WhatsApp.

**Rejected alternatives:**
- *Adopt native agents with compensating controls.* The credential read-through
  is automatic and silent; there is no hook to compensate at.
- *ZMQ for agent-to-agent messaging.* A new daemon, port and failure mode, with
  no durability and no reconcile path, to buy latency that is irrelevant at
  p95 = 1 Bot. Rocky's SQLite is the bus and the existing per-container
  WebSocket is the doorbell (rule 6, `docs/PATTERNS-durable-work.md`). OpenMuse — careful about durability
  — chose durable state plus a 60s reconcile loop over any transport.
- *Forbid Bots from spawning Bots.* Unnecessary once a spawn is an actionRequest
  to the main agent: every Bot is then structurally a child of main, runtime
  depth stays 1, and containment is structural rather than dependent on a
  per-agent limit OpenClaw cannot express. Needs `requestedBy` (logical parent,
  for audit) separate from `spawnedBy` (always main, for containment).
- *Reserve a warm container for a Bot's whole lifetime.* Not feasible and not
  needed. A lease is durable and costs bytes; a container is capacity and is
  reclaimable. Only `RUNNING` holds a container (rule 1, `docs/PATTERNS-durable-work.md`).

**Risks / edge cases found:**
- Releasing a container mid-run requires the run to be reconstructible from
  storage alone, so checkpoints at irreversible boundaries are a prerequisite,
  not a later refinement.
- `better-sqlite3` cannot be opened by separate processes — OpenMuse documents
  the identical constraint for PGlite. A separate Bot worker process collides
  with this immediately.
- Leases keyed on wall-clock time are safe on one host and unsafe on two. Decide
  before a second host exists.
- ~~Our version pin contradicts this log.~~ **Resolved 2026-09-24:** `2026.7.1-2`
  is the intended pin. The log was wrong, not the code; the OpenClaw pin row has
  been corrected.


## 2026-09-24 A bot reports every step to the ledger, but messages the user only on a decision

**Decision:** a spawned bot writes every step to Rocky's durable ledger. It sends a
WhatsApp message only when it is **blocked**, needs a **permission/approval**, has a
**final result**, or hits any other **human-in-the-loop** point. Step history is read
on demand, not pushed.

**Why:** WhatsApp allows **1 message per 6 seconds to a user** (~10/minute) and
**explicitly does not guarantee ordering** between them. A per-step message would
spend that budget on progress noise and arrive scrambled when two bots report at
once. There is also no such thing as a silent message on WhatsApp — every one is a
push notification — so the platform gives us no way to distinguish "informational"
from "needs you", which a screen-based UI gets for free.

xAI's Grok Bot resolves this the same way: notifications fire only when a Bot
"finishes or needs input", while the transcript records every tool call, file and
approval request. A2A generalises it — the chat message is a cheap, ordering-tolerant
*push*, and the full record is *re-fetched* from our store.

**Rejected alternatives:**
- *A message per step.* Ten steps is a minute of rate limit and ten notifications.
- *The typing indicator as a progress signal.* It expires after 25 seconds and cannot
  be read back, so a long run silently looks stopped — the worst failure mode.
- *Batching several steps into one periodic message.* Still spends the budget, still
  pushes, and delays the two events that actually matter.

**Risks / edge cases found:**
- The ledger becomes the only progress record, so a `status` command is not optional.
- A bot that finishes after the 24-hour customer-service window closes cannot send a
  plain message at all and needs an approved template.
- Blocked/approval messages must carry enough context to be acted on hours later,
  because approval governs only the next action and reverses nothing already done.

## 2026-09-24 Step completion is verified host-side; the CLI hook is not the mechanism

**Decision:** an agent marks a step complete by calling `complete_step` on Rocky's
agent MCP endpoint, and Rocky verifies the claim against its own records before
recording it. The Claude CLI `TaskCompleted` hook is **not** the control. It may
later be added as defence-in-depth, but only if it gains a credential the model
cannot read and config the container cannot write.

**Why:** the hook cannot work as a control in this architecture, for two
independent reasons found by tracing the container contract.

First, the container can rewrite its own hook config. OpenClaw forces
`--setting-sources user`, so project settings are never loaded and hook config
must live at `tenants/<id>/cli-home/claude/settings.json`. That path is mounted
`:rw` (`docker-gateway.mjs:304`) and `grantTree` grants the container user
group-write (`:262-264`). A veto whose config the vetoed party can edit is not a
veto.

Second, the hook's only available credential is the agent's own. The container
cannot reach the host ledger — `tenants/<id>/data` is not in `tenantMountSpec`,
and `test/container-mounts-contract.test.mjs:19-25` asserts exactly four mounts —
so a hook must verify over the network using the bearer token from
`/run/rocky-input/composio.json`, which is the same `agentToken` already in the
model's MCP config. A hook authenticating with it is indistinguishable from the
agent it polices.

Verifying host-side is also simpler: the veto becomes structural, because the only
way to mark a step done is to ask the host.

**Rejected alternatives:**
- *The `TaskCompleted` hook with exit 2.* The mechanism is real and present in the
  CLI, but it is not a control here for the two reasons above.
- *An LLM judge on completion claims.* Across five judges and five prompt
  strategies, no configuration exceeded AUROC 0.65 — near coin-flip. A TF-IDF
  detector reached 0.83–0.95 and recovered 4–8× more false successes at 3,300×
  lower latency.
- *A fifth mount exposing the ledger read-only to the container.* It would break
  `test/container-mounts-contract.test.mjs:19` and, more importantly, it puts the
  verification data where the verified party can read it.

**Risks / edge cases found:**
- A genuinely unverifiable step ("researched X") is **logged, not gated**. Stated
  explicitly in the spec and in the code. The mitigation is scope: unverifiable
  steps must not be the ones that touch the outside world.
- The drift analysis read OpenClaw 2026.6.35 locally, not the pinned 2026.7.1-2.
  Whether hooks fire under `claude -p` at all, and whether our `rocky` MCP server
  is proxied as `mcp__openclaw__*`, are unverified. Neither blocks this design;
  both block the hook fallback.
- The Claude CLI is installed unpinned (`Dockerfile.openclaw:19`) while OpenClaw
  beside it is pinned and asserted. Anything depending on CLI behaviour needs a pin.
- `docs/ROCKY-codebase-audit.md` proposes dropping the `cli-home` mount entirely.
  This design does not depend on it; a hook fallback would.

## 2026-09-24 The lease lives on `turns`, not in a separate table

**Decision:** lease ownership is expressed as columns on the existing `turns` row
— `lease_owner`, `lease_until`, plus `parent_run_id`, `requested_by`, `spawned_by`
— rather than as a separate `leases` table.

**Why:** `turns` already carries `runtime_id` and `runtime_generation`, stamped at
claim (`queue-store.mjs:157-166`), and `attempt`. That is already an owner
identity; it is missing only an expiry. A separate table would introduce a third
identity for the same unit of work alongside `request_id`, which is already
`UNIQUE` and already documented as "the idempotency key that makes total
re-execution safe to retry" (`migrations.mjs:84-85`).

**This reverses part of the 2026-09-23 entry**, which approved "a lease table". The
evidence that entry cited says the opposite: OpenMuse carries `leaseId`/`leaseUntil`
on the work row — "no separate lock table, no external coordinator; ownership is an
attribute of the work". The earlier entry generalised "lease" into "lease table"
without re-reading the source.

**Rejected alternatives:**
- *A separate `leases` table.* Lower cohesion, a third identity, and every read of
  "who owns this turn" becomes a join.
- *Reusing `runtime_generation` alone as the lease.* It has no expiry, so a dead
  owner is indistinguishable from a slow one — which is the whole problem.

**Risks / edge cases found:**
- `turns.updated_at` is ISO-8601 text (`queue-store.mjs:23-25`) while
  `cron_schedule_mirror.next_run_at_ms` is epoch-ms (`migrations.mjs:214`). The
  repo is inconsistent; the lease column must pick one deliberately.
- Lease TTL must interact with `busy_timeout = 250`
  (`test/tenant-data-store.test.mjs:31-45`), so an explicit `SQLITE_BUSY` retry
  story is required.
- Wall-clock leases are safe on one host and unsafe on two. Unchanged from the
  2026-09-23 risk note.

## 2026-09-24 The periodic reconcile sweep must not ship before lease expiry

**Decision:** the sweep slice is sequenced strictly after the lease slice, and
every destructive action in it gains the predicate "and its lease has expired".
Boot recovery keeps its current unconditional form.

**Why:** running today's recovery on a timer would be actively destructive, and
this was not obvious from the outside. `recoverInterruptedTurns` rewrites *every*
`claimed` row with no owner and no age predicate (`queue-store.mjs:271-274`). On a
timer, a turn claimed seconds ago and legitimately executing is yanked back to
`queued` and the model is re-invoked while the first call is still running. With
write tools enabled the branch at `:253-259` turns every `claimed` row into
`failed`/`UNCERTAIN_WRITE`, so no turn could ever complete. `markSendStartedUnknown`
(`:386-391`) has the same shape and would reclassify healthy in-flight sends.

The sweep is boot-only today precisely because at boot, by construction, nothing is
running. A periodic sweep is safe only once "this turn's owner is dead" is a fact
in the database rather than an assumption about process lifetime.

**Rejected alternatives:**
- *Ship the sweep first because it is small.* It is small and destructive.
- *Add a `notified` column so the sweep can skip completed work.* Rejected on rule
  2: that column is one more write lost in the same crash. The fix for a
  non-idempotent `sendText` is a per-turn resend floor, not a completion flag.

**Risks / edge cases found:**
- The `writesEnabled: true` recovery branch is **completely untested today** — no
  test passes `writesEnabled`. That is the branch this change makes most dangerous.
- `recoverInterruptedTurns` returns `0` in that branch despite mutating rows
  (`:266`), and `router.mjs:575` sums it. A sweep with a wrong counter is worse
  than no sweep.
- The sweep must not create databases (`test/router-inbound.test.mjs:76-87`), must
  `.unref()` (`test/boot-smoke.test.mjs:51-53`), must not swallow its own errors,
  and must respect `draining`.

## 2026-09-24 We cut a long reply ourselves, and keep every part's provider id

**Decision:** `deliverResponse` splits the committed reply with
`chunkForWhatsApp` and sends one provider message per part, recording every
returned id in a new `message_parts` table. `quotedMessage` resolves a reply
against `messages.external_message_id` **or** `message_parts.provider_message_id`.
The reply stays one `messages` row, so the transcript and replay are unchanged.

**Why:** Twilio accepts a body over WhatsApp's ~1600-character limit and
delivers it as several messages, each its own Message resource with its own SID,
while the send call returns only one of them. Every SID we never saw was a
message the user could reply to and we could not resolve, so `quotedMessage`
returned `{found:false}` and the agent was handed a reply with the quoted text
missing.

Measured on the live tenant: at 11:48:20–21 on 2026-09-24 four provider messages
went out — 1059 + 847 + 841 + 943 characters, one long reply — and only the 841
was in our database. Every other message in that window was short and every one
was recorded. 62 of 77 replies resolved; the 15 misses were all replies to long
messages. The failure was deterministic, not intermittent: a short reply is one
provider message and always resolves, a long one is N and we held 1 of N.

**Rejected alternatives:**
- *One `messages` row per part.* The transcript would then carry a long answer as
  four rows, and `turns.response_message_id` is a single foreign key — it would
  have pulled the turn state machine into the change, which specs 01–02 are about
  to rewrite.
- *Let the provider keep splitting and store the ids it reports.* The send call
  returns one id; the others are never reported. We cannot record what we did not
  create.
- *Cap replies at the limit and truncate.* Silently losing the end of an answer
  is worse than the bug.

**Risks / edge cases found:**
- The limit is 1500, not 1600, to leave headroom.
- A fenced code block is kept whole where it fits; splitting one renders as
  broken monospace on both halves.
- If a send fails mid-way the loop stops, the ids collected so far are still
  recorded, and the attempt is marked with the failing receipt. The parts already
  delivered are real and must remain resolvable.
- `recordMessageParts` is `INSERT OR IGNORE` on `(message_id, part_index)` with a
  unique index on `provider_message_id`, so a resend cannot duplicate a part.
- This does **not** fix the second hole found in the same investigation: about
  twenty `channel.sendText` sites — all of `onboarding.mjs`, `router.mjs:451`,
  `tenant-activation.mjs:51`, `index.mjs:246` and `:503` — send real messages that
  are never recorded at all. `recordOutboundMedia` already exists as the pattern
  for the media case. Still open.

---

# Retroactive entries — 2026-09-24

The phase specs were deleted on 2026-09-20 and `docs/README.md` said their
section numbers "resolve through `DECISIONS.md`". An audit of every
`SPEC-phase3c` citation in `src/` found that false for four sections and thin for
five more. The specs are **not** recoverable: `SPEC-phase3c*` was never committed
to git, and `docs/` is not in `deploy/rsync-exclude.txt`, so `rsync --delete-after`
removed the production copies on the first deploy after 2026-09-20.

Each entry below was verified against the code and the test that pins it, not
reconstructed from memory.

## R1 — The model call resolves on terminal completion only, and a turn is never retried in-turn

**Decision:** the SSE reader resolves a turn only on `response.completed`. A
failed turn is re-executed in full by the scheduler; the runtime never retries
inside the turn.

**Why:** resolving on a quiet token stream is ambiguous — *"a pause in the token
stream is indistinguishable from a finished response, so a slow tool call could
be reported as a complete answer and committed as the turn's result"*
(`tenant-openclaw.mjs:664-671`). An earlier version returned after 800 ms of
silence and did exactly that.

In-turn retry is refused for three separate reasons, stated at
`tenant-openclaw.mjs:847-851`: a second attempt *"would hide the failure from the
durable layer, bill a second model call, and make the turn non-atomic — the first
attempt may already have run tools."* Only the scheduler knows whether the
response was committed, so only the scheduler may retry.

**Rejected alternatives:** a quiet-stream heuristic (shipped, then removed for the
reason above); retrying inside `runOpenclawTurn` where the failure is closest.

**Risks / edge cases found:** `response.completed` costs a few seconds of gateway
post-processing on every turn. That latency is the price of not committing a
half-finished answer. Pinned by `test/gateway-supervision.test.mjs:85-104`.

## R2 — OpenClaw's session is a cache; the durable transcript is the memory

**Decision:** Rocky's own encrypted transcript is the agent's memory. The
runtime's session is a fast path and may be absent at any time.

**Why:** `context-store.mjs:6-14` — runtime-native history *"may compact, prune,
reset, or change format"*, and *"under hibernation with quarantine-on-migration, a
cold session is now ordinary rather than rare."* Without replay the agent
*"starts blank every time that happens while the full conversation sits encrypted
in `data/tenant.sqlite`."*

This is the premise the whole context-assembly design rests on, and it is the
application of **P8** — do not build guarantees on state you do not own.

**Rejected alternatives:** trusting the runtime session as memory, which makes
every hibernation a silent amnesia event.

**Risks / edge cases found:** `DECISIONS.md:17` still says the canonical
transcript is "not implemented until Phase 3C" and was never updated; it is
implemented. Replay costs tokens on every generation change. Pinned by
`test/docker-runtime-fixes.test.mjs:90`.

## R3 — The privacy guard blocks seven classes; ordinary personal data is allowed

**Decision:** the guard blocks **authorization codes, passwords, API keys,
tokens, cookies, private keys and payment-card secrets** from becoming
transcript. Everything else, including ordinary personal information, is allowed
and encrypted.

**Why:** `policy-guard.mjs:1-14`. Those classes *"route through the dedicated auth
flow or a provider-hosted payment page instead"* — storing them buys nothing and
creates a liability. Blocking ordinary personal data would make the transcript
useless for its purpose.

A finding never carries the matched text: *"a guard that echoed the secret into
an error message would defeat its own purpose, since errors reach logs."*

**Rejected alternatives:** redaction rather than blocking — `DECISIONS.md:31`
already records that a policy hit blocks the message rather than redacting it.
The class list itself was never written down until now.

**Risks / edge cases found:** the list is the contract; adding a class silently
changes what can be stored. Pinned by `test/tenant-data-store.test.mjs:234`.

## R4 — Migrations are append-only; never edit a shipped migration's SQL

**Decision:** a shipped migration's SQL is frozen. Changes are appended as a new
migration.

**Why:** `migrations.mjs:31-38` — *"the recorded checksum is compared on every
open, and a mismatch is a hard failure rather than a silent divergence between
what a tenant database actually contains and what this code assumes."*

**Risks / edge cases found:** this is enforced at `migrations.mjs:294-300` and
stated in prose only at `migrations.mjs:35` and `docs/features/03:18-19` — never
in the decision log until now. Migration 002 rebuilds `turns`, and that rebuild
once cascade-deleted every `turn_messages` row, which is why `PRAGMA
foreign_keys` is toggled **outside** the migration transaction.

## R5 — The turn envelope is immutable

**Decision:** the recipient is frozen onto the turn at enqueue; the runtime id
and generation are stamped at claim and validated at completion. A result from a
replaced container is rejected as stale.

**Why:** `queue-store.mjs:105-112` — *"Delivery later reads it from the turn,
never from a module variable and never from an address supplied by the tenant or
the model."* This is what makes it structurally impossible for a model to choose
who receives a message, and what stops a result from an evicted container
overwriting a newer one.

**Risks / edge cases found:** a cold-start turn stamps `runtime_generation = null`,
so the generation check is skipped for exactly the turn that creates the
container. Pinned by `test/turn-correlation.test.mjs:36-124`.

## R6 — The SQLite pragma values, and why each was chosen

**Decision:** `journal_size_limit = 64 MiB`, `cache_size = -2000` (KiB, not
pages), `busy_timeout = 250 ms`, and `synchronous` set explicitly on every
connection.

**Why:** `open.mjs:10-18`. The journal limit is explicit because the default
(`-1`) never truncates and *"a leaked reader was measured growing a WAL from
3.94 MB to 247 MB."* `synchronous` is set per-connection because the build has
`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so *"any connection that skips the pragma
silently commits at NORMAL and loses the power-loss durability §4 requires."*

**Risks / edge cases found:** `busy_timeout = 250` is short, and any future lease
or sweep design must carry an explicit `SQLITE_BUSY` retry story rather than
assuming the driver waits.

## R7 — Boot order: everything reconciles before the channel accepts traffic

**Decision:** stop containers belonging to no known tenant → start the gateway
supervisor → start the wake scheduler → recover interrupted lanes → resend
committed responses → only then accept inbound traffic.

**Why:** `index.mjs:136-176`. Accepting a message before recovery means a turn
left mid-flight by a crash competes with a new one for the same lane, and a
committed-but-unsent reply may be overtaken by a newer answer.

**Risks / edge cases found:** the order is pinned by a code-shape assertion
(`test/wiring-regressions.test.mjs:16-20`), not by a runtime check. Recovery skips
tenants with no database file, deliberately — opening a store would create one.

## R8 — `turn resolve` throws with an explanation rather than not existing

**Decision:** the action exists and raises *"turn resolve does not exist:
pre-commit failures re-execute automatically"* (`resources/turn.mjs:24-31`).

**Why:** an operator who reaches for it is acting on a wrong model of the system.
A missing action teaches nothing; an error that explains why teaches the
invariant.

**Risks / edge cases found:** `DECISIONS.md:52` records the action as *absent*,
not as *throwing*. If write-capable tools are ever enabled, interrupted turns
become `UNCERTAIN_WRITE` and an operator resolution path genuinely is needed —
at which point this error message becomes wrong. Pinned by
`test/shutdown-backup-operator.test.mjs:210-214`.

## R9 — The SQL bans are enforced by text-scanning tests, and the recorded reason is now stale

**Decision:** `.prepare()` outside `src/tenant-data/` and any bare
`new Database()` outside `src/tenant-data/open.mjs` are forbidden, enforced by
tests that scan raw file text.

**Correction:** `DECISIONS.md:30` justifies this with *"the repo has no lint
toolchain — the only eslint dependency is a vendored no-op stub satisfying a
Baileys peer requirement."* **That is no longer true.** Baileys and the stub were
removed on 2026-09-24 (`af3aa1a`), and `package.json` now carries
`eslint ^9.39.5` with `"pretest": "eslint ."`. The tests remain the enforcement
and should stay — a raw-text scan catches a violation inside a comment or a
string, which a linter's AST would not — but the stated reason no longer holds.

**Risks / edge cases found:** because the scan is on raw text, a comment
containing `.prepare(` trips it. Any spec touching these files must keep that in
mind.


## R14 — `assertHostCapacity` is dead code held alive by a test

**Decision, recorded rather than acted on:** `assertHostCapacity`
(`src/openclaw/tenant-gateway.mjs:133-138`) has **no caller in `src/`**. Its only
caller is `scripts/gate-pool.mjs:108`, a gate script. Yet
`test/gateway-supervision.test.mjs:171-178` asserts on its body, so the function
cannot be deleted without editing that test.

**Why it exists:** it was the hard-refusal capacity check before admission gained
the ability to evict. The live gate is now `admitTenant`
(`tenant-gateway.mjs:120-131`), which may evict and refuses only in its last
phase.

**Why this is recorded now:** a reader finding two capacity checks cannot tell
which one is live, and a spec that "fixes" the wrong one would change nothing.
Left in place deliberately — it is the gate script's only capacity assertion —
but it is not the production path.

**Risks / edge cases found:** the test asserting on a function nothing calls
gives false confidence that the invariant is enforced on the live path. It is
enforced, but by `admitTenant`, and by different code.

## 2026-09-24 Every turn-state write names the state it was planned against

**Decision:** each `UPDATE turns SET state` carries `AND state = <expected>`,
taken from the row read inside the same transaction. A zero-row result is a
signal, not silence. `completeTurn` and `saveResponse` raise
`StaleTurnResultError`; `claimNextTurn` returns `null` (the caller already
handles "nothing to claim"); `beginSend` returns `null` and its three callers
skip; `recordSendResult` and `markDeliveryUnknown` tolerate it, because a
provider callback that already settled the turn is allowed to win.

`applyProviderStatus` is **exempt and must stay exempt**. It exists to correct a
record after the fact — a late `delivered` rescuing a `delivery_unknown` turn —
so a prior-state predicate would disable the one thing it is for. Monotonicity is
enforced on the right axis instead: `STATUS_RANK` against the *attempt's* status,
so a callback cannot move a delivery backwards but can still settle a turn.

**Why:** the expectation came from the row we just read, so no caller passes it
and none of the ~20 test edits the spec anticipated were needed.

**Corrected during implementation, by measurement rather than reasoning.** The
first version of this entry claimed the predicate was what protects
`completeTurn` and `saveResponse` from a second writer. It is not. A real
two-connection race was run: `bin/tenant.mjs` opens the same database, and when
it commits between this transaction's read and its write, SQLite aborts with
**`SQLITE_BUSY_SNAPSHOT`** — the predicate never gets a chance to return zero
rows. So in those two functions the CAS is unreachable in every case: same
transaction in-process, and aborted before it across processes.

That measurement exposed the real defect. `inbound-queue.mjs:216` catches
`StaleTurnResultError`, so a genuine race was raising a driver error code no
caller recognised. `asStaleIfRaced` now converts any `SQLITE_BUSY*` into a stale
result, which is the shape callers are built for. The test for it fails when the
conversion is removed.

`beginSend` is the one place the predicate genuinely fires, because its UPDATE is
the **first** statement in its transaction with no prior read — so a state
changed beforehand is simply not matched. That is the reachable guard, and it is
tested both ways.

The unreachable predicates are kept rather than deleted: the reads sit inside
their transactions today, and anything that later moves a read out would silently
remove the only guard. Each now carries a comment saying which mechanism actually
fires.

**The substantive fix is in `beginSend`.** It previously had no guard at all, and
wrote the `delivery_attempts` row *before* touching the turn. The live send
(`router.mjs`) and the boot resend can both reach a `response_saved` turn; the
loser committed an orphan `sending` row for a send that never happened, which
also shifted every later attempt number. The turn claim now happens first, so a
lost race leaves no trace.

**Rejected alternatives:**
- *Return `{changed:false}` everywhere.* Every call site treating a falsy return
  as success would need auditing; the existing `StaleTurnResultError` already has
  a caught, tested handler.
- *A caller-supplied expected state.* That is what would have cost ~20 mechanical
  test edits, for no extra safety over reading the row in the transaction.
- *Guarding `applyProviderStatus` too.* It would break delivery correction.

**Risks / edge cases found:**
- The invariant is enforced by a **source scan**, because an intra-process race
  cannot be staged in one process. The scan accepts `AND state =` for a row
  update and `WHERE state =` for a set-based recovery sweep.
- `markDeliveryUnknown` now leaves a turn alone if a callback already settled it.
  That is the intended behaviour and is tested, but it is a behaviour change: the
  turn no longer becomes ambiguous after it was resolved.
- **Not done, deliberately:** the spec proposed fixing `recoverInterruptedTurns`
  to return its true mutated-row count in the writes-enabled branch. On reading
  the callers, the returned value is summed into a counter logged as *"recovered
  N interrupted turn(s)"*, and in that branch turns are marked `UNCERTAIN_WRITE`
  rather than recovered — so `0` is arguably correct, and the count is already
  reported by a `console.warn`. Changing the return type would break three
  callers to fix a naming ambiguity. Left alone; recorded here so it is not
  rediscovered as a bug.

## 2026-09-24 One *executing* turn per tenant, not one active turn

**Decision:** three waiting states — `waiting_subrun`, `awaiting_approval`,
`retry_wait` — each named after the event that ends the wait. A turn in one of
them is **parked**: it holds its work but runs nothing. The lane predicate now
means *executing* (`claimed`, `response_saved`, `send_started`), so a parked turn
does not block the next message.

**This changes a stated invariant.** "One active turn per tenant" becomes "one
*executing* turn per tenant" — a parked turn and a running turn coexist.

**Why:** the old predicate was `state NOT IN (queued, <terminal>)`, so a turn
waiting on a human approval refused every later turn for that tenant,
indefinitely. `TURN_TIMEOUT_MS` could not rescue it: that timer lives only for
the duration of `executeTurn`'s await, and a parked turn has already returned.
And because coalescing joins only `queued` turns, the user's later messages piled
up silently — the busy-ack was deliberately removed in an earlier decision.

**Consequences, accepted deliberately:**
- **Replies can arrive out of request order.** You ask about a flight, it parks
  on your approval, you ask the time, you get the time first. The alternative is
  deadlocking the conversation on a human.
- **The executing turn does not know a parked one exists.** The "tell the user
  what is blocked" half of the approved D2 is **not built** — it needs a place to
  say it, which is the approval slice.
- A resumed turn returns to `queued` and re-enters through the normal claim path,
  so it cannot run alongside a live one. The bound holds: still one model call,
  one container, one session per tenant at a time.

**Recovery treats each wait by what it was waiting on.** `waiting_subrun` and
`retry_wait` were waiting on something in memory that died with the process, so
they requeue. `awaiting_approval` was waiting on a human, who did not, so it is
left untouched and surfaced in a warning — requeuing would re-execute the turn
and ask twice. Nothing writes that state yet; the slice that makes approvals
durable owns its recovery.

All three are **pre-commit**: no response is committed, so a crash re-executes
rather than re-sends. That keeps the existing §6 split intact.

**Rejected alternatives:**
- *A single `blocked` state.* Three different waits need different timeouts,
  different escalation, and mean different things to an auditor. Rule 9.
- *Letting a parked turn keep blocking and adding a busy-ack.* That restores the
  ack an earlier decision deliberately removed, and still leaves the user waiting
  on their own approval.
- *Building the scheduler's "parked" outcome now.* Nothing writes these states
  yet, so it would be untestable speculation. It belongs with the slice that
  introduces the transitions into them.

**Risks / edge cases found:**
- Migration 007 rebuilds `turns` because SQLite cannot `ALTER` a CHECK. Unlike
  002 it copies every column straight across — 002 nulled `recipient`, which did
  not exist as an envelope yet — and remaps nothing.
- Verified against a copy of production **including the WAL**. The first attempt
  copied only the `.sqlite` file and was silently testing stale data; that also
  means the earlier migration-006 check was weaker than recorded. Redone: 667
  messages, 320 turns, 348 `turn_messages`, 319 attempts, 5 message parts, 320
  recipients and the state distribution all preserved, both indexes recreated,
  0 FK violations.
- `contextNeeded` is deliberately unchanged. A parked turn has not settled, so
  its generation is not a comparison point; and the older comparison point errs
  toward replaying *more* context, which is the safe direction.

## 2026-09-24 A provider status callback wakes the lane it just released

**Decision:** `applyProviderStatus` now reports `settled` when a terminal
callback moves a turn out of the executing set, and `handleStatusWebhook` calls
an injected `onTurnSettled` — wired to `wakeTenantLane` — when it does. The
callback is injected rather than imported so the transport layer keeps no
dependency on the scheduler.

**Why — observed in production, not theorised.** A message sat `queued` for
11 minutes with `inFlight: 0`, `queueDepth: 1` and no container warm. The
sequence:

1. Turn A's reply is sent. Twilio *accepts* but does not confirm, so A correctly
   stays `send_started` — acceptance is not delivery.
2. `executeTurn`'s `finally` runs, sees work queued, wakes the lane. `pump` asks
   `claimNextTurn`, which sees A still executing and returns `null`. Correct.
3. Seconds later Twilio's `read` callback settles A. `handleStatusWebhook`
   updated the row, closed the store, and returned 204 — **without telling
   anyone the lane was now free.**

Nothing re-checks after that point, so turn B waited for the next inbound
message to wake the lane. If none came it would wait forever.

**This is pre-existing, not introduced by the waiting-states work.** The old
lane predicate also treated `send_started` as blocking, so the same stall was
always reachable. It needs a turn whose provider callback lands after its
`finally` has already run, with another message queued behind — a slow turn
plus impatient follow-ups, which is what a foreground subagent produces.

**Rejected alternatives:**
- *Import the scheduler into `channels/`.* The transport layer already takes
  `openStore` injected for exactly this reason; importing would couple it to the
  scheduler and create a cycle through `index.mjs`.
- *Wake on every callback.* Most callbacks are `queued`/`sent` and settle
  nothing. Waking on those is churn that hides the one that matters.
- *Poll for stranded queued turns.* That is the periodic sweep, which is a later
  slice and needs lease expiry first. This is the precise fix for the precise
  hole.

**Risks / edge cases found:**
- `settled` is now returned on **every** path, including the early
  `unknown_provider_message` and `out_of_order` returns. A test caught it being
  `undefined` on those; the webhook coerced with `Boolean()` so it was safe, but
  a field that is sometimes absent is a trap for the next caller.
- `wakeTenantLane` no-ops unless the lane is already in memory and has work, so
  a callback for an idle or unknown tenant costs nothing.
- A throwing wake is caught and logged: the provider must still get its 204, or
  it will retry the callback.

## 2026-09-24 WhatsApp formatting rules live in the org guardrail block

**Decision:** a `<formatting>` section is added to the managed guardrail block in
`org/templates/workspace/AGENTS.md`, bumped to **v4**. It ships in the org
bundle and is injected into every tenant's workspace — no skill, no MCP server,
no per-tenant configuration.

**Why:** the rules are always true for every tenant on this transport, so they
belong in the always-read position (**P11**). A skill or MCP tool is a
conditional path: it is consulted only by an agent that already decided to
consult it, which is exactly when formatting advice is not needed.

**What it says, and why it differs from the obvious advice.** The common
guidance is "never use Markdown on WhatsApp". That is **wrong for this system**:
`toWhatsAppText` already converts `**bold**`, `# headings`, `[label](url)` and
`- bullets` on the way out, so telling the agent to avoid Markdown would have it
avoid something already handled, and invent worse emphasis instead.

What genuinely does not survive, verified by running the formatter:
- **Markdown tables** pass through as raw `|` pipes — unreadable on a phone.
- **Nested list indentation** is flattened to one level.

So the section names those two, states what does render, and notes that a long
reply is split at a paragraph boundary — which makes writing in paragraphs the
thing that keeps a split from landing mid-sentence.

**Risks / edge cases found:**
- The org bundle is checksum-verified per file, so editing a template fails
  tenant provisioning until `org build` regenerates the manifest. That is the
  integrity check working; the bundle went 2026.09.22-rocky.6 → rocky.7.
- `GUARDRAIL_VERSION` must move with the template or the block is not rewritten
  in existing workspaces. Bumped v3 → v4.
- It does not contradict the existing `<length>` rule, which already says an
  answer past a screenful should be a file rather than a long message.

## 2026-09-24 The outbox refuses to deliver the same bytes twice

**Decision:** `deliverOutbox` hashes each file's contents and skips any whose
bytes have already been delivered for that tenant, moving the copy to `sent/`
without sending it. The set is seeded from `sent/` and grown during the drain,
so duplicates written within a single turn also collapse to one send. Genuinely
different content, and a revision under the same filename, still go out.

**Why:** a user received the same diagram three times. The first explanation —
that the agent checked `outbox/sent/` mid-turn, wrongly concluded the send had
failed, and re-sent — was **wrong**, and the user caught it: all three arrived
*at once*, not spread across the turns where each supposed re-send happened.
They were written as three files in one turn and the outbox faithfully delivered
every one.

A guardrail telling the agent not to re-check and not to re-send was written and
then **removed**. It narrated a sequence the evidence did not support, and it
put the rule in the weakest possible place: prose addressed to a model, for a
property the system can simply enforce. Identity of a delivery is its content,
so the outbox compares content. A rename is not a different file.

**Rejected alternatives:**
- *A guardrail telling the agent not to re-send.* Advice, not enforcement, and
  based on a misreading. Removed.
- *Dedupe on filename.* The observed case used renamed copies
  (`…-v2`, `…-final`), which is exactly what an unsure agent produces.
- *Dedupe on a per-turn set only.* It would miss a file rewritten on a later
  turn, which is the other half of the same behaviour.

**Risks / edge cases found:**
- A legitimate re-send of identical bytes is now suppressed — asking for the
  same unchanged file again delivers nothing. Acceptable: the file is already in
  the conversation, and a *changed* file has different bytes and still sends.
- A duplicate is still moved into `sent/`, so nothing is left behind to be
  re-delivered on the next drain.
- Hashing reads every pending file. Bounded by `MAX_FILES_PER_TURN` (3) and the
  existing 16 MB media cap.
- An unreadable file is treated as not-a-duplicate and follows the existing
  failure path rather than being silently dropped.
- `.svg` remains named in the guardrail block as undeliverable. That is a fact
  about the channel the agent cannot otherwise know, not a behavioural patch.

## 2026-09-25 One cron wake carries every job a tenant has due

**Decision:** `collectDue()` groups a tenant's due jobs into a single wake
request carrying `jobIds[]`, and `cronWarm` tracks that set rather than one job
id. `completeCronWake()` refreshes the mirror and hibernates only when none of
the jobs it woke for is still due; if the mirror could not be refreshed it
hibernates anyway. Duration is recorded only when a wake carried exactly one
job.

**Why:** the container wake is the expensive unit, not the job. The previous
code queued one entry per job, then `pumpWakes()` shifted the second entry, saw
the tenant had just become warm, and `continue`d — discarding it. `collectDue()`
skips warm tenants, so it never came back. Two jobs scheduled at 09:00 meant one
ran and the other vanished with no error. `completeCronWake()` also hibernated
on the first delivery, killing any sibling still running.

The delivery payload (`{tenantId, runId, text}`) never names its job, so
completion cannot be counted from callbacks without depending on a payload
shape OpenClaw owns and we do not. OpenClaw advances `next_run_at_ms` when a job
fires, so "still due after a refresh" is the same fact read from real state.

**Rejected alternatives:**
- *Per-job webhook URLs carrying the job id.* Works, but makes every delivery
  depend on our own rewrite of each job's webhook staying in sync, and adds a
  second identity for a job that already has one.
- *Counting deliveries down to zero.* A job that fails without posting would pin
  the container warm forever.
- *One wake per job.* Multiplies container starts by the number of jobs due,
  which is exactly what the slot budget exists to prevent.

**Risks / edge cases found:**
- A null mirror refresh means OpenClaw's state was unreadable. That is absence
  of evidence, not evidence a job is pending, so the slot is released rather
  than leaked; `preemptOverruns()` remains the backstop.
- A coalesced wake's elapsed time is attributable to no single job, so nothing
  is recorded. Predictions stay honest at the cost of learning more slowly.
- `predictedMs` for a coalesced wake is the sum of its jobs' predictions, since
  turns serialise per tenant.

## 2026-09-25 Several accounts per toolkit, selected explicitly

**Decision:** MCP sessions are created with
`multi_account={enable, max_accounts_per_toolkit, require_explicit_selection}`,
`connected_accounts.link` passes `allow_multiple=True`, `ConnectionStatus`
carries `account` and `display_name`, and `disconnect` takes an optional
connection id. Only a half-finished authorization blocks a new Connect Link; an
ACTIVE account no longer does. The CLI refuses a bare `disconnect` once more
than one account is connected.

**Why:** the tenant had three ACTIVE Gmail connections and the agent could only
ever see one, so "check my rvce mail" was answered with "I can't". Composio's
tool router already solves this: `COMPOSIO_MANAGE_CONNECTIONS` supports several
accounts per toolkit, and every execution takes an `account` argument the model
must name when more than one is connected. Nothing needed building — the flags
were simply never passed. `require_explicit_selection` is the load-bearing one:
without it the router silently picks a mailbox.

This closes BL-001, which deferred the capability on the assumption it needed
our own account selector.

**Rejected alternatives:**
- *Our own account labels and selector.* A second source of truth for identity
  Composio already owns, and it could not steer which account a tool call used.
- *Leaving `disconnect` toolkit-wide.* With one account it was equivalent; with
  three it silently deletes two the user did not name.

**Risks / edge cases found:**
- `data.displayName` is present for Gmail and Linear but absent for Google Drive
  and Calendar, so `display_name` may be null and `account` (Composio's
  `word_id`, or an alias once set) is the stable handle.
- The account limit is enforced by us before Composio sees the request; the
  router enforces its own limit independently.
- `_call()` wrapped every exception as `UpstreamFailure`, so a 404 for an
  unknown connection id surfaced as a 502. `ConnectorError` now passes through.

## 2026-09-25 Outlook is registered; the auth config was the blocker

**Decision:** created a Composio managed-OAuth auth config for Outlook
(`ac_McabwYHRri4T`) and restored `outlook` to `org/mcp/registry.json`.

**Why:** Outlook was previously removed because no auth config existed, so every
connect attempt failed at the provider with nothing the user could do. The
missing piece was the auth config, not the code. `src/agent-mcp.mjs` meanwhile
still advertised `outlook` in its toolkit examples while omitting Drive and
Linear, so the model offered a service it could not connect.

**Risks / edge cases found:**
- A pinned `authConfigId` decides the consent-screen scopes. Without one the
  connector falls back to the first OAUTH2 config mentioning the toolkit, which
  is how an over-broad consent screen reaches a user unnoticed.
- Editing the registry without `org build` fails provisioning, because every
  bundle file is checksum-verified.

## 2026-09-25 The NDA templates no longer name a renderer that does not exist

**Decision:** removed every `legal_doc.render` reference from
`org/templates/legal/nda/{README.md,rules.yaml,schema.json}`. The `nda-builder`
skill renders the document.

**Why:** the org bundle ships these templates into every tenant workspace, and
they instructed the agent to call a Hermes tool that was never ported. Building
a renderer would duplicate a skill that already works.

## 2026-09-25 The wake lead is not charged against a cron job's budget

**Decision:** `preemptOverruns()` measures from `max(startedAt, dueAtMs)` rather
than from the wake, and a requeued wake is marked due immediately.

**Why:** found by the first live cron run. `WAKE_LEAD_MS` is 60s, so a container
is woken a minute before its job is due. The overrun budget is
`max(predictedMs, DEFAULT_DURATION_MS) * OVERRUN_FACTOR`, and for a job with no
history that is `20s * 3` = exactly 60s. The budget therefore expired at the
precise moment the job became due, so every first run of every job was
preempted and its container stopped mid-turn. The smoke-test job was killed
twice in a row and its result never reached the ingress.

The lead exists so the container is ready when the job fires. It is scheduling
overhead, not job work, and charging it to the job guaranteed the failure.

**Rejected alternatives:**
- *Raise `OVERRUN_FACTOR` or `DEFAULT_DURATION_MS`.* Hides the error by making
  the budget bigger than the lead, and breaks again if the lead is raised.
- *Measure the duration model from the due time too.* Prediction feeds queue
  ordering by slot occupancy, which genuinely starts at the wake. Changing both
  conflates two different quantities.

**Risks / edge cases found:**
- Budget is derived from a prediction that includes the lead but is now applied
  to runtime that excludes it, so preemption is slower than before. That is the
  safe direction: preemption is a backstop, and killing live jobs is the failure
  being fixed.
- `dueAtMs` is absent on entries created before this change, so it falls back to
  `startedAt` and behaves as it used to.

## 2026-09-25 Cron results authenticate with OpenClaw's own webhook token

**Decision:** Rocky writes `cron.webhookToken` into each tenant's OpenClaw
config, set to `ROCKY_CRON_WEBHOOK_TOKEN`. OpenClaw sends it as
`Authorization: Bearer <token>` on every cron webhook POST, which is what
`verifyCronToken` already required.

**Why:** the first live cron run reached Rocky and was rejected. Caddy's access
log showed `POST /internal/cron/delivery` returning **401**, twice, matching the
two test jobs. `openclaw cron add` has no flag for a webhook credential, so
every job posted anonymously into an ingress whose own rule is that an empty
token denies everything. Two faults compounded: OpenClaw sent no token, and
`ROCKY_CRON_WEBHOOK_TOKEN` was never set on the host, so the ingress would have
denied every delivery even if one had been sent.

Reading the pinned image showed `buildCronWebhookHeaders(webhookToken)` setting
the bearer header, sourced from `cfg.cron.webhookToken` — a config key, not a
per-job flag.

**Rejected alternatives:**
- *Carry the token in the webhook URL.* The URL is stored in OpenClaw's job
  table and logged by Caddy on every request, so the secret would be at rest in
  two places that are not secret stores.
- *Drop the token and authenticate by source address.* Delivery crosses the
  public internet (BL-011), so there is no trustworthy source address.

**Risks / edge cases found:**
- `cron.webhookToken` was validated against the pinned image before use
  (`config validate` → `valid: true`), with `cron.skipMissedJobs` as a control
  returning `valid: false`. An unverified key here is what took the fleet down
  on 2026-09-18.
- The token reaches the tenant's OpenClaw config, which is mounted rw into the
  container. It is a shared secret between Rocky and its own containers, and
  grants only the ability to POST a cron result for a tenant the server
  resolves itself. It does not pass the `mcp.servers.composio` plaintext guard's
  concern.
- Rotating the token requires recycling every tenant so the config is rewritten.

## 2026-09-25 The cron ingress reads OpenClaw's payload and takes the tenant from the URL

**Decision:** a cron job's webhook is `…/internal/cron/delivery?t=<tenantId>`.
`handleCronDelivery(payload, channel, tenantId)` takes the tenant as an argument
resolved by the route from that query, never from the body. The result text is
`payload.summary` and the run identity is `jobId:runId`, falling back to
`jobId:runAtMs`.

**Why:** the third live test reached Rocky authenticated and was rejected 400.
Rocky required `{tenantId, runId, text}`; the pinned OpenClaw posts a cron event
whose fields are `jobId`, `runId`, `summary`, `status`, `runAtMs`, `durationMs`
and `job`. Nothing in that payload is named `tenantId` or `text`, and nothing
ever would be — OpenClaw has no concept of a Rocky tenant. Expecting the
provider to match our shape was the error.

Taking the tenant from the URL also makes an invariant true that the docs
already claimed: the feature docs said the tenant was resolved from server state
and never the payload, while `handleCronDelivery` was reading
`payload.tenantId`. A container that sent another tenant's id would have been
believed. It is now ignored, and a test asserts that.

This mirrors the Twilio status callback, which already identifies its tenant
with `?t=` (`tenantFromStatusQuery`), so there is one pattern for provider
callbacks rather than two.

**Rejected alternatives:**
- *Keep reading `tenantId` from the body and have Rocky inject it when creating
  the job.* OpenClaw controls the payload; there is no field for us to set.
- *Derive the tenant from the job id.* Needs a host-side index of job to tenant
  that would have to stay in step with OpenClaw's own table — a second source of
  truth for something the URL can carry directly.
- *Use `jobId` alone as the dedupe key.* A recurring job would deliver once and
  every later run would be swallowed as a duplicate.

**Risks / edge cases found:**
- Jobs created before this change carry a webhook without `?t=`.
  `jobsNeedingWebhook` compares against the expected per-tenant URL, so
  `reconcileCronWebhooks` rewrites them on the next wake.
- Both callers had to change: the gateway route and the Docker-bridge listener
  (`cron-ingress-listener.mjs`), which parsed the path with `split('?')[0]` and
  so discarded the query.
- A payload with no `runId` and no `runAtMs` cannot be deduplicated and is
  refused rather than delivered on a guessed identity.

## 2026-09-25 Sarvam provider client written as a standalone slice

**Decision:** `src/speech/sarvam.mjs` is the Sarvam speech client — STT in, TTS
out — and `src/transcription.mjs` delegates to it when `SARVAM_API_KEY` is
configured. Nothing else changed: `src/router.mjs` still calls the seam with a
bare file name, so voice notes remain untranscribed in production until the
durable media-job worker in `playground/sarvam-audio/README.md` is built.

Contract facts taken from Sarvam's published docs, not from the prototype:
auth is the `api-subscription-key` header; sync `POST /speech-to-text` accepts
OGG/Opus directly (no ffmpeg needed, which the 2026-09-21 decision requires) and
is capped at **30 seconds** of audio; `POST /text-to-speech/stream` caps text at
**3500 characters** and returns raw audio in one of eight documented codecs;
models are `saaras:v3`/`saaras:v4` for STT and `bulbul:v2`/`bulbul:v3` for TTS.

**Why:** the retry/secrecy/confinement behaviour is where voice actually goes
wrong, and none of it is observable once the client is buried behind a webhook.
Building and testing it alone, with `fetchImpl` injected, makes every rule —
403 terminal, 429 retried, timeout aborted, key redacted, no partial outbox
file — a test that fails when the rule is removed. Each of those was verified by
mutation, not assumed.

Retry classification is a field on `SarvamError` (`retryable`, `status`,
`operation`, `attempts`), not a parsed message. A durable media-job worker needs
to branch on it to decide requeue versus fallback, and parsing English out of an
error string is exactly the heuristic that rots.

The TTS temp file is named `.<basename>.partial-<pid>-<rand>` in the destination
directory. `pendingOutbox()` skips dot-files and delivers everything else, so a
visible temp file would be delivered half-written; a temp file in another
directory would make the rename non-atomic. Both constraints are load-bearing
and tested.

**Rejected alternatives:**
- *Re-derive the upload content type from the file extension* (what the
  prototype does). Twilio already records `MediaContentType0`, and the saved
  name is generated from that type — deriving it back is a lossy round trip that
  mislabels an Opus note saved with a `.wav`-ish extension. `contentType` is a
  required caller argument.
- *Enforce the 30-second limit client-side.* ffmpeg is gone by decision, so
  duration is not measurable without decoding. The provider enforces it and
  returns a terminal 4xx. The client enforces a **byte** ceiling instead, which
  is its own guard (bounded memory and upload), not a proxy for duration.
- *Let `transcription.mjs` swallow provider failures and return null.* The
  router already catches and falls back; swallowing there would destroy the
  retryable/terminal distinction before any future worker can use it.
- *Widen `router.mjs` to pass the media record.* Out of scope for this slice and
  it belongs with the durable media-job change, not with the client.

**Risks / edge cases found:**
- Sarvam publishes **no byte-size limit** for the sync endpoint. Default
  `maxInputBytes` is 8 MiB, chosen so it cannot reject a legitimate ≤30 s clip
  even uncompressed, and it is a caller option. It is a chosen default, not a
  documented fact.
- Sarvam does not publish retry semantics. The classification (408/429/5xx and
  timeouts retryable, 401/403/other 4xx terminal) is standard HTTP semantics
  applied by us, and transport failures are treated as retryable.
- 401 is not documented for these endpoints — auth failures appear as 403 with
  an `authentication_error` code. Both are classified terminal.
- The docs list `saaras:v3` as the REST default and `saaras:v4` as available;
  the prototype used v4. The client defaults to the documented `saaras:v3` and
  leaves the model a caller option.
- `eslint.config.mjs` gained the Node 22 web globals (`FormData`, `Blob`,
  `Response`, `File`, `Headers`, `Request`, `AbortSignal`). `no-undef` is an
  error and these are real built-ins the project had simply never declared.


## 2026-09-25 The gateway's body reader has one named contract

**Decision:** `readBody` moved out of `src/index.mjs` into
`src/http-body.mjs` as `readParsedBody(req)`, whose name states that it returns
parsed JSON. `test/http-body.test.mjs` pins that contract.

**Why:** the cron ingress route did `JSON.parse(await readBody(req))`. The
gateway's `readBody` already parsed JSON and returned an object, so this parsed
an object — `"[object Object]"` — threw, and answered 400. **Every cron
delivery over the public route had failed this way since the route was written**,
which is why no scheduled job had ever reached a user.

Two functions named `readBody` existed with opposite contracts: the gateway's
returned a parsed object, the Docker-bridge listener's returned a raw string.
Both call sites read `JSON.parse(await readBody(req))`; the listener's was
correct and the gateway's was not. The name carried no contract, so neither
reader could be wrong on inspection.

**Rejected alternatives:**
- *Fix the one call site and move on.* Leaves two same-named functions with
  opposite contracts, which is the condition that produced the bug.
- *Make both return raw strings.* Four other gateway routes depend on the parsed
  object; changing them widens a delivery fix into a rewrite of the API surface.

**Risks / edge cases found:**
- Caught only by a live probe, never by a test: the suite covered the bridge
  listener's route but not the gateway's. The new test asserts that parsing the
  result again throws, so the exact mistake fails loudly.
- The listener keeps its own reader, which enforces a 256 KiB cap the gateway's
  does not. Unifying them is deferred rather than rushed into a delivery fix.


## 2026-09-25 A provider retry is recognised before any paid work happens

**Decision:** `handleInbound` checks `alreadyAccepted(store, …)` before
`collectAttachments`. A webhook whose provider message id is already in
`messages` returns immediately, downloading nothing and transcribing nothing.
`transcribeIfPossible` now passes the whole saved media record to the
transcription seam rather than only its file name.

**Why:** `src/router.mjs` fetched media and ran speech-to-text at line 553, and
`enqueueForTenant` deduplicated on `MessageSid` at line 558 — expensive work
sitting in front of the dedupe. With the old stub returning null that was free.
With a paid cloud provider it means every Twilio retry re-downloads the audio
and re-bills a transcription, and because a slow transcription is itself what
makes Twilio time out and retry, the failure feeds itself.

The seam also received only `saved.file`, a bare name, while the provider needs
the content type Twilio recorded. Re-deriving that from the file extension is
inferring a fact we already hold, so the whole record is passed instead.

**Rejected alternatives:**
- *Move transcription after persistence.* The durable transcript is the memory,
  and `transcriptBodyFor` folds the words into the persisted body. Transcribing
  afterwards means either a body without the words or mutating a sealed one.
- *A background worker claiming media jobs.* Correct for Batch STT of clips over
  30 seconds, and `media_jobs` (migration 008) exists for it. It is not needed to
  stop paying twice for a retry, and adding a second lane before the first one is
  needed is machinery ahead of the requirement.

**Risks / edge cases found:**
- A message with no provider id cannot be proven a retry and is treated as new.
  Dropping it would lose a real message; the duplicate cost is bounded.
- A crash between the check and the enqueue can still transcribe twice. One
  extra provider call, no user-visible duplicate.
- The sync endpoint caps at 30 seconds and ffmpeg is gone, so duration cannot be
  measured locally. A longer voice note fails terminally and falls back to
  "not transcribed" until Batch STT lands on `media_jobs`.


## 2026-09-25 A voice note is answered by voice, and the text still goes

**Decision:** when a turn's attachments include a successfully fetched audio
note and `SARVAM_API_KEY` is set, the reply is synthesized to
`workspace/outbox/reply-<turnId>.mp3` before `settleFiles()` runs, so the
existing `deliverOutbox()` sends it. The written reply is still committed and
sent as normal.

**Why:** the outbox already owns outbound files — signed expiring links, the
provider media allow-list, content-hash dedupe and outbound-media recording.
Synthesizing into it reuses all of that instead of adding a second delivery
path, which the parity spec forbids. `audio/mpeg` is already in the Twilio
allow-list, so an MP3 is deliverable without touching the adapter.

The text is not replaced. The committed reply is what the durable transcript
holds and what the delivery ledger's persist-before-send invariant is written
against; suppressing its send would leave a persisted message that was never
delivered and a turn whose terminal state no longer matches what the user got.
Sending both keeps the ledger honest and leaves the user something skimmable —
a voice note cannot be searched or re-read at a glance.

**Rejected alternatives:**
- *Replace the text with the audio.* Cleaner as a product, but it moves the
  turn's terminal state out of `deliverResponse` and into the outbox, which is a
  change to the turn lifecycle rather than an addition to it. Worth doing
  deliberately, not as part of adding speech.
- *Speak every reply.* A voice note that no one asked for is worse than text,
  and it doubles outbound volume against a shared sender already rate-limited to
  one message per six seconds per user (BL-006).

**Risks / edge cases found:**
- Synthesis failure never costs the reply: `speakReply` catches everything and
  logs, and the written answer has already been committed.
- A reply over Sarvam's 3500-character limit is not spoken and not truncated —
  half an answer read aloud is worse than a whole one written down.
- A voice note we failed to fetch does not trigger a spoken reply; answering by
  voice would imply we heard something we did not.
- Two outbound messages per spoken turn. If the six-second rate limit becomes
  the binding constraint, replacing the text rather than adding to it is the
  decision to revisit.

## 2026-09-25 The Bland call lifecycle is built as a durable layer with no model-reachable entry point

**Decision:** `src/voice/bland-client.mjs`, `src/voice/webhook.mjs` and
`src/tenant-data/voice-store.mjs` implement the whole outbound-call lifecycle on
migration 009, and **nothing is projected to the model**. `src/agent-mcp.mjs` and
`agentActions` in `src/tenant-cli/registry.mjs` are untouched, and a test walks
`src/` asserting that neither file mentions voice or Bland and that
`approveCall` has no production caller anywhere outside its own module. The
`requested -> approved` edge exists in the state machine with zero callers.

**Why:** placing a phone call is irreversible, and `awaiting_approval` is still a
schema state with no producer, so there is no durable approval gate to put in
front of it. A tool the model can reach would make the model the approver. The
lifecycle is the part worth building now precisely because it is the part that
has to be correct *before* anything can dial; the dialing itself is one function
call that can be wired up the day a real approval gate exists.

**Rejected alternatives:**
- *Ship a `call request` tenant-CLI resource now* (the playground README's plan).
  It needs `registry.mjs`, which is out of scope for this slice, and a
  `tenantSelfService` resource is reachable from the agent surface — the exact
  thing that must not exist yet.
- *Ship it behind an env flag.* A flag is a deployment property, not a durable
  approval; the whole point of the gap is that the approval must survive a crash.

**Risks / edge cases found:**
- Nothing schedules, reconciles or times out a call. A call stuck in `submitted`
  because the webhook never arrived stays there forever. `listVoiceCallsByState`
  exists for the reconciler; the reconciler does not.
- `voice_calls.approval_id` is a free text column. Whatever eventually produces
  `awaiting_approval` must own its meaning.

## 2026-09-25 Call creation is single-attempt; a create that times out is "placement uncertain", not "failed"

**Decision:** `createCall` defaults to `maxAttempts: 1`. `getCall` and `stopCall`
default to 3. `BlandError` carries `placementUncertain`, set when the failure was
a timeout, a transport error, a 5xx, or a 200 with no `call_id`. The caller
records `submitted` with a null `provider_call_id` **before** the POST, and binds
the id afterwards through `bindProviderCallId()`.

**Why:** verified against Bland's docs on 2026-09-25 — `POST /v1/calls` has **no
idempotency key and no `Idempotency-Key` header**; the only server-side guard is
an undocumented "one call per number per 10 seconds" 429. A retried create
therefore dials a human twice. Ordinary retry-on-5xx is correct for a read and
actively harmful here, so the difference is expressed in the default rather than
left to each caller to remember.

Persisting `submitted` before the POST is the same persist-before-send invariant
the delivery ledger already uses: a crash between the POST and the write would
otherwise leave a live call with no record of it. Because our correlation is the
callback reference in the webhook URL — not the provider's id — a call whose
`provider_call_id` was never captured is still fully recoverable when the webhook
lands.

**Rejected alternatives:**
- *Retry create on 5xx like every other call.* Doubles a real phone call.
- *Add an `uncertain` state.* Migration 009 is fixed and `submitted` with a null
  `provider_call_id` already carries exactly that meaning without a schema change.
- *Correlate on `request_data`.* Bland documents `request_data` as unavailable
  when the call is not answered; `metadata` survives, but the signed callback
  reference is ours and does not have to be trusted back from the provider.

**Risks / edge cases found:**
- Bland documents **no `Retry-After`** on `/v1/calls` 429s. The backoff is
  entirely ours; `retryAfterMsFrom` reads the header only if one shows up.
- The 10-second-per-number 429 means a legitimate second call to the same person
  can be rejected. It surfaces as `retryable: true`, which is correct, but
  nothing yet paces calls per destination.
- `max_duration` is capped locally at 60 minutes (`MAX_DURATION_LIMIT_MINUTES`)
  and defaults to 15. Bland's own default is 30 and its ceiling is undocumented;
  this bound is **ours**, deliberately tighter, and overridable per call.

## 2026-09-25 Webhook signatures are verified over raw bytes; replay defence is the fingerprint, not a timestamp

**Decision:** `verifyWebhookSignature` takes a `Buffer` or `string` and **throws**
if handed a parsed object. HMAC-SHA256, hex, `timingSafeEqual`, and both
`X-Webhook-Signature` and `X-Bland-Signature` are accepted. Replay is defeated by
`voice_call_events.fingerprint UNIQUE`; `withinReplayWindow()` is offered
separately for the timestamp *inside* the signed body, defaulting to 900s.

**Why:** verified on 2026-09-25 — Bland signs the webhook body with a
dashboard-issued secret (not the API key) and **sends no timestamp header and no
replay window**. Its own sample verifies `JSON.stringify(req.body)` with `===`,
which is both non-constant-time and dependent on our JSON serializer matching
theirs byte for byte; verifying the received bytes is strictly stronger and is
what Bland actually signed. Bland's docs give the header as
`X-Webhook-Signature` on the signing page and `X-Bland-Signature` on the web-chat
page, so both are accepted rather than guessing which deployment sends which.

A replay window built on an *unauthenticated* header would be theatre. The only
timestamp an attacker cannot forge is one inside the signed body, so that is the
one `withinReplayWindow` is meant to be applied to — and it is a separate
function so it can never be mistaken for something the signature check already did.

**Rejected alternatives:**
- *A Stripe-style `t=…,v1=…` scheme.* Bland does not send one; implementing it
  would be inventing a contract.
- *Verify `JSON.stringify(JSON.parse(raw))` to match the docs' sample.* Accepts
  any attacker payload that re-serializes identically and breaks on key order.
- *Accept only `X-Webhook-Signature`.* Would silently drop every delivery if the
  other name is what a given account actually sends.

**Risks / edge cases found:**
- 900s is a **guess about Bland's undocumented webhook retry schedule**, not a
  verified figure. Bland says retries happen but publishes no schedule, and the
  delayed post-call payload arrives 30–60s later. It is an option, and the
  fingerprint constraint — which is permanent, not a window — is the real defence.
- Signing of the *streamed* `webhook_events` payloads is not documented, only
  "Bland webhooks" generally. `webhook_events` is therefore not subscribed to by
  default.
- Bland publishes no secret-rotation window; replacing the signing secret is a
  hard cutover and will reject in-flight deliveries.

## 2026-09-25 The transition table is the only declaration of the call state machine

**Decision:** `LEGAL_VOICE_TRANSITIONS` declares every legal edge.
`VOICE_TERMINAL_STATES` is **derived** from it (a terminal state is one that
declares no successors). `recordProviderEvent` projects an event only when the
table allows the edge. `VOICE_STATE_RANK` survives for exactly one job: deciding
whether a late event may overwrite `summary`, `transcript`, `answered_by`,
`ended_by`, `error_code` and `completed_at`.

**Why:** the first version guarded webhook projection three ways — the transition
table, `!isVoiceTerminal(...)`, and `incomingRank > currentRank`. Mutation testing
found the last two **unkillable**: every legal edge already increases rank, and
every terminal state already declares no successors, so neither guard could ever
fire on its own. Three declarations of one truth is three things that can drift.
A test now asserts the invariant the rank ordering depends on (every legal edge
strictly increases rank) instead of re-checking it at runtime.

**Rejected alternatives:**
- *Keep all three as defence in depth.* They are not independent. A future legal
  edge that did not increase rank would be silently blocked by a guard nobody
  remembered was there — a worse failure than the one being defended against.
- *Drop `VOICE_STATE_RANK` entirely.* Enrichment ordering is a real, separate
  question the transition table does not answer: a reordered event must not write
  its older view of the summary over a newer one.

**Risks / edge cases found:**
- `busy` and `no-answer` are mapped to `failed`, not `completed`. Bland's `status`
  enum treats them as distinct from `completed`, and the call never connected —
  but this is **our judgement about what the state machine means**, not a Bland
  fact. `answered_by`, `disposition_tag` and the raw sealed payload are all kept,
  so the mapping can be revised without losing evidence.
- Bland's `status: "unknown"` maps to no state at all: the event is recorded and
  the call is left where it was, rather than guessed at.
- A streamed event's lifecycle lives in a free-text `message` ("Call connected").
  It is deliberately **not** parsed; streamed events project no state.

## 2026-09-25 Provider payloads are sealed but not policy-guarded

**Decision:** `requestCall` runs `assertPersistable()` on the operator-authored
task before sealing it. Provider-returned transcript, summary and raw event
payloads are AEAD-sealed under their own per-column record names
(`voice_destination`, `voice_task`, `voice_summary`, `voice_transcript`,
`voice_event`) but are **not** passed through the persistence policy guard.

**Why:** the guard's action is to *throw*, and §7 makes a hit block the write
outright. On the request path that is right — it surfaces at request time, to a
human, before anything is dialled. On the webhook path it would mean a call whose
transcript happens to contain an OTP can never reach a terminal state: the write
fails, we cannot return 2xx, Bland retries, and the call is stuck forever while
the evidence is discarded. Losing the durable record is a worse outcome than
holding it encrypted, which is exactly how message bodies are already held.

Per-column record names mean the AAD binds each ciphertext to both its tenant and
its column, so a `destination_cipher` cannot be read as a task and a row copied
into another tenant's database fails to decrypt rather than leaking.

**Rejected alternatives:**
- *Guard the transcript too.* Wedges the call and destroys the record.
- *One `voice_call` record name for every column.* Cheaper, but then ciphertext is
  interchangeable between columns; a test asserts it is not.
- *`sealMessageBody()` for everything.* It is the transcript path's seal — it
  bundles the guard, which is the thing that must differ here.

**Risks / edge cases found:**
- A call transcript is now a place secrets can come to rest that the §7 guard does
  not see. It is encrypted at rest and tenant-bound, but the retention story for
  voice transcripts is **not** written yet.
- Recording defaults to off and `recording_consent` defaults to 0. Nothing yet
  downloads a recording; Bland's `recording_url` is external and expiring and must
  not be treated as durable storage.
- Enrichment columns are overwritten by any non-regressive event. Bland's delayed
  post-call payload (30–60s later, with `corrected_transcript`) is therefore
  allowed to win, which is the intent.


## 2026-09-25 An operator at a terminal is the approval gate for a phone call

**Decision:** outbound calls are reachable only through a `voice` tenant-CLI
resource with no `agentActions` and no `tenantActions`, and `approveCall` has
exactly one caller — that resource. `POST /webhooks/bland/<callbackRef>`
receives provider callbacks, verifies the signature over the raw bytes and
records the event.

**Why:** the durable approval design (§3.3) does not exist and
`awaiting_approval` still has no producer, so nothing in the system can hold a
model's request for a human decision. The purpose of that gate is to stop a
model dialling a real person unilaterally. An operator running
`tenant voice call --tenant … --to … --task …` **is** a human decision, made
before anything reaches the provider, so the property the gate exists to protect
is already held. The model-facing surface stays closed until the real gate
exists.

Two tests enforce it and now assert the property rather than an absence:
`agent-mcp.mjs` carries no voice reference, the `voice` resource declares no
agent or tenant actions, and `approveCall` is called from that resource and
nowhere else.

**Rejected alternatives:**
- *Wait for §3.3.* Correct in principle, but it blocks a working call path
  behind a multi-hour design slice, and an operator-initiated call does not need
  the machinery a model-initiated one does.
- *Expose it as an agent tool with a prompt-level confirmation.* Prompt-level
  confirmation is exactly what the parity spec rules out, and it is the model
  deciding either way.

**Risks / edge cases found:**
- `verifyWebhookSignature` returns `{ok, reason}`, and the first version of the
  ingress wrote `if (!verifyWebhookSignature(...))`. An object is always truthy,
  so **the signature was never enforced** on a public endpoint. Caught by a test
  that signed a re-serialized body; the check now reads `.ok`.
- Caddy routed `/webhooks/*` to `localhost:9119`, the dead hermes-gateway, so
  every Bland callback would have 502'd. `/webhooks/bland/*` was added to the
  block that reaches Rocky, ahead of the stale matcher.
- `src/index.mjs` already had a `readRawBody` returning a string while the new
  one returned a Buffer — the same two-readers-one-name shape that broke cron
  delivery. The new one is `readBodyBytes`, named for its contract.
- Still absent: a reconciler for a call whose webhook never arrives, per-number
  pacing against Bland's 10-second 429, and a retention policy for voice
  transcripts.


## 2026-09-25 An unverified voice callback is refused, and the opt-out is explicit

**Decision:** the Bland webhook refuses when `BLAND_WEBHOOK_SECRET` is unset.
Setting `BLAND_WEBHOOK_REQUIRE_SIGNATURE=false` allows callbacks authenticated
only by the unguessable callback reference in the URL, and logs a warning once.
A configured secret is always enforced, opt-out or not.

**Why:** the Hermes implementation this replaces was fail-open —
`webhook_routes.py:59` returns `True` from `_verify_bland_signature` when no
secret is configured, and no secret was ever set on the host. Signature
verification on that public endpoint was therefore disabled for its whole life,
and anyone who learned the URL could post call results.

Our callback reference is `HMAC-SHA256(callbackSecret, callKey)` with only its
SHA-256 stored, so the URL is itself a bearer credential and cannot be guessed
from a database read. That is a real control, and materially stronger than
fail-open, but it is weaker than a provider signature: it does not prove the
sender is Bland, and it is replayable by anyone who observes the URL. So it is
available, and it is never the default.

**Rejected alternatives:**
- *Match Hermes and treat "no secret" as verified.* It reads as verification
  while performing none, which is worse than having no check at all.
- *Refuse until a dashboard secret exists, with no alternative.* Correct, but it
  blocks the whole path on a console setting, and the reference already provides
  a defensible control for an operator-initiated call.

**Risks / edge cases found:**
- In opt-out mode a callback URL that leaks — a proxy log, a screenshot — is
  replayable until the call settles. The `fingerprint UNIQUE` constraint still
  stops the same body being recorded twice.
- The warning fires once per process, so it will not be visible in a log tail
  taken hours after boot.

## 2026-09-25 Every send path honours the provider's media allow-list

**Decision:** `deliverWorkspaceFile` and the `send_file_to_user` agent tool both
check `deliverableBy()` before minting a signed link. An undeliverable type
throws, and the tool's message tells the model to convert to PDF and explicitly
not to claim the file was sent.

**Why:** only `deliverOutbox` checked. The other two paths — the `MEDIA:` marker
the model emits, and the agent tool it calls directly — minted a link and sent
it regardless. Twilio accepts a link to a `text/plain` file, returns 200 and a
message SID, and the recipient receives nothing. The model then reports success,
because from where it stands the send succeeded.

Found by a regression audit, not by a test: `send_file_to_user` did not even
call `deliverWorkspaceFile`, so fixing that function alone would have left the
agent path silently broken.

**Rejected alternatives:**
- *Refuse at the channel adapter.* The adapter sends a URL and does not know the
  file behind it; the type is only knowable where the workspace path is.
- *Convert to PDF automatically.* Silently changing what the model asked to send
  hides the mistake from it, and the conversion toolchain is not present on
  every path.

**Risks / edge cases found:**
- A channel that declares no `mediaTypes` is not second-guessed; the check only
  refuses when the channel has actually stated what it accepts.
- This is the fourth silent-success defect found today, after the cron ingress
  401s, the deprecated TTS model, and a call payload with no model. All four
  had the same shape: a provider returning a success code while nothing reached
  the user.

## 2026-09-25 Speech fixes found by regression audit

**Decision:** three changes to the voice path, all found by auditing rather than
by a failing test.

1. **The speaker guard no longer depends on the model being the default.** It was
   `model === DEFAULT_TTS_MODEL && !BULBUL_V3_SPEAKERS.includes(speaker)`, so
   setting `SARVAM_TTS_MODEL` to anything else — a typo, or a future
   `bulbul:v4` — turned off the check that exists because this pairing broke
   production twice. It is now keyed on the model actually in use via
   `MODEL_SPEAKERS`, and a model whose voices we do not know passes through
   rather than being refused on a list we cannot have.

2. **Synthesis moved off the critical path.** `speakReply` ran before
   `deliverResponse`, so a Sarvam outage that hangs rather than refuses could
   delay the user's *written* answer by the full retry ladder — roughly 61s with
   shipped defaults. The written reply is now sent first and the spoken one is
   attempted after; the audio still reaches the outbox before delivery settles.

3. **A voice note that was too long now says so.** The failure reason was
   discarded in the catch, so the user was told "transcription unavailable" with
   no hint that a shorter message would have worked. The reason is classified
   and carried into the attachment preamble, and the agent is told the 30-second
   limit and told not to guess at the contents.

**Risks / edge cases found:**
- Inbound media accepts 16 MB (`inbound-media.mjs:7`) while the STT client
  refuses above 8 MB. Not a defect — refusing before a paid call is correct —
  but the two ceilings disagree and only the client's is explained to the user.
- Sarvam's 30-second cap cannot be enforced before upload: ffmpeg was removed by
  the 2026-09-21 decision, so duration is not measurable locally. A long note
  therefore still costs one request to discover. Batch STT on `media_jobs`
  (migration 008) is the real answer and is not built.

## 2026-09-25 A sync only recycles when the connection set actually changed

**Decision:** `syncTenant` compares a fingerprint of the tenant's ACTIVE,
approved connections against the one it last stored. When they match and an
endpoint is already stored, it reuses that endpoint, skips `client.resolve()`
and does not recycle the container.

**Why:** `changed` compared the stored endpoint to a freshly resolved one, and
`sessions.create` mints a new MCP URL on every call. So `changed` was true on
every sync regardless of whether anything had changed, and every sync ran
`recycleTenantGateway`, which is `docker rm` on the tenant's container. An
in-flight WhatsApp turn dies with it, and `mcp sync-all` does it to every
tenant in turn. The CLI's own gateway pool is empty, so the stop is ungraceful.

The endpoint is a function of which accounts are connected, so that is what
decides whether it needs re-minting. The fingerprint is order-independent,
because Composio returns connections in no guaranteed order, and ignores
non-ACTIVE and non-approved connections, because neither reaches the endpoint.

**Rejected alternatives:**
- *Compare the URL but skip the recycle when only the URL differs.* The stored
  endpoint would still be rewritten on every sync and a Composio session minted
  each time, for nothing.
- *Never recycle on sync.* A genuinely new mailbox would not reach the running
  container until it happened to restart.

**Risks / edge cases found:**
- An endpoint invalidated server-side without any connection change will not be
  re-minted by a sync. `mcp doctor` still reports endpoint health, and a
  connect/disconnect forces a real re-resolve.
- Redaction matched `endpoint` as a substring, so `endpointReady` and
  `storedEndpoint` — both plain booleans — were returned as `[REDACTED]`,
  hiding the one field that says whether the sync produced anything. The
  pattern now matches the key exactly.
- The `disconnect` refusal advertised a `--all` flag that nothing reads; it now
  points at `mcp revoke`, which is the real bulk path.

## 2026-09-25 A call the webhook missed is recoverable by an operator

**Decision:** added operator-only `voice reconcile`. It lists calls still in
`submitted`/`ringing`/`in_progress`, asks the provider what actually happened
with `getCall`, and records the result through `recordProviderEvent` under a
deterministic fingerprint (`reconcile:<providerCallId>:<status>`) so running it
repeatedly is safe. It is absent from `agentActions`.

**Why:** the webhook ingress was the only writer that could move a call past
`submitted`, and `getCall` was exported and called from nowhere. Four callbacks
arrived before the settlement fix, the gateway answered **200** to each and
recorded nothing, and Bland does not retry a 200. Three real, billed, completed
conversations — one with a 261-character transcript — became permanently
unreadable to the tenant, and `voice status` would report them in flight
forever. Any future missed callback does the same.

Two smaller faults fixed with it:
- `voice stop` called `stopCall({ callId })` while the client destructures
  `providerCallId`, so stop threw before issuing a request and could never
  reach the provider. It failed closed, so nothing was lost but the feature.
- The ingress computed `providerAt` and `completedAt` and forwarded neither, so
  `voice_call_events.provider_at` was always NULL and a settled call kept
  `completed_at = NULL` — indistinguishable from an open one, with ordering
  falling back to local receive time.

**Rejected alternatives:**
- *A background sweeper.* Right eventually, but it polls a paid API on a timer
  for a case that should be rare once webhooks work; an operator command is
  honest about being a repair tool.
- *Re-POSTing the callback ourselves.* Fabricates provider input into a path
  whose whole purpose is to record what the provider said.

**Risks / edge cases found:**
- A test asserted the destination number never appears in the tenant database.
  That passes only because a fixture tenant has no message history: on a real
  tenant the same number is cleartext in `messages.channel_account` and
  `turns.recipient`, because it is the conversation's own address. The voice
  tables add no new cleartext copy, which is what the test actually proves, and
  it now says so.
- `voice_call_events.fingerprint` is globally UNIQUE rather than unique per
  call, so two different calls with byte-identical callbacks would drop the
  second. Real Bland payloads embed `call_id`, so this is theoretical; left as
  is and recorded here.

## 2026-09-25 A cron job's budget starts when its container is ready

**Decision:** `pumpWakes` sets `startedAt` **after** `deps.wake()` resolves, so
the overrun budget measures the job running, not Rocky acquiring a container.
Preemption is bounded by `MAX_CRON_ATTEMPTS` (3), counted per *run* — keyed on
tenant plus the run's due time — and a run that exhausts its attempts is left
alone until its next due time rather than re-queued. `reconcileCronWebhooks`
now runs on the wake as well as on completion.

**Why:** found by a live regression test, and it is the reason **no cron job
has ever delivered end to end on this host**. The earlier fix stopped the 60s
wake *lead* being charged to the job; it did not stop the container *start*
being charged. Measured on prod:

```
15:17:18.711  job due
15:17:29.3    startedAt set, wake called
15:17:44      docker run      (15s gone)
15:17:56      gateway ready   (27s gone; the turn only begins now)
15:18:29.36   docker stop     (startedAt + 60000ms exactly)
```

`max(predictedMs, DEFAULT_DURATION_MS) * OVERRUN_FACTOR` is 60s for an unproven
job, so roughly 33s remained for a Sonnet turn that routinely needs 30-90s. The
real production job hit it too: `0f3f7dba` "daily AI news briefing" recorded
`cron: job interrupted by gateway restart` after 93561ms.

Worse, it did not stop. `completeCronWake` clears the only thing that ends a
cycle and its sole caller is a *successful delivery*, so a job that could never
deliver pinned its tenant in a permanent 60-second wake/kill loop, burning a
cron slot and churning containers. 18 preempt lines were in the log.

`reconcileCronWebhooks` had the same shape: its only caller was inside
`completeCronWake`, so a job whose webhook lacked `?t=` could never deliver, and
therefore could never have its webhook repaired. Chicken and egg.

**Rejected alternatives:**
- *Raise `ROCKY_CRON_OVERRUN_FACTOR`.* Masks a clock that starts in the wrong
  place, and breaks again whenever container start is slow.
- *Exclude container start by subtracting a constant.* A guess standing in for a
  real signal; `deps.wake()` already resolves exactly when the container is
  ready.
- *Let preemption retry indefinitely.* That is the observed behaviour and it is
  what turned one failing job into permanent container churn.

**Risks / edge cases found:**
- Attempts are keyed on the run's due time, so a retry must preserve the
  original `dueAtMs`. Setting it to `now` on requeue mints a fresh key and the
  cap never bites — that is exactly how the first version of this fix failed its
  own test.
- Giving up leaves the job scheduled. It is retried at its next due time, which
  is correct for a recurring job and means a one-shot can be lost; a one-shot
  that overruns three times is a job that cannot run.
- `bin/tenant.mjs` segfaults on Node 18 (better-sqlite3 ABI) instead of
  reporting an unsupported version. The host default is 18; the service uses
  22.22.1. Not fixed here.

## 2026-09-28 A lost provider callback cannot mute the agent indefinitely

**Decision:** cron delivery passes `tenantId` to `sendText`, and a new
`sweepStalledSends()` runs every 60s, moving any turn that has sat in
`send_started` past `ROCKY_STALE_SEND_MS` (10 min) to `delivery_unknown` and
waking the lane.

**Why:** the first cron job this system ever delivered wedged the tenant for 23
hours. `src/cron-ingress.mjs:81` called `channel.sendText(recipient, text)`
without `tenantId` — the only send path that did. Without it the Twilio status
callback URL carries no `?t=`, and `handleStatusWebhook` returns 204 with
`reason: 'no tenant scope'` because it cannot tell whose turn it is. All six
callbacks for that message were discarded that way. Every one of the 31
tenant-less callbacks in the whole access log came from that single nine-second
window; the other 1497 carried `?t=` and applied.

The turn therefore never left `send_started`. One executing turn per tenant is
the lane rule, so the next turn could not be claimed and five user messages
coalesced behind it, unanswered. Twilio's own record says the message was `read`
within eleven seconds — the user got the briefing; Rocky never learned it landed.

`markSendStartedUnknown` already existed but only ran on shutdown and crash
recovery. A process that keeps running never swept, so the wedge survived
indefinitely and only a restart would have cleared it.

**Rejected alternatives:**
- *Mark it `completed`.* Acceptance is not delivery. `delivery_unknown` exists
  precisely so a message that may already have been sent is never resent.
- *Treat a tenant-less callback as the one warm tenant.* Guesses whose message
  it is, and is wrong the moment two tenants are warm.
- *Shorten the lane rule to let a queued turn overtake a sending one.* Breaks
  ordering, which is the reason the rule exists.

**Risks / edge cases found:**
- The sweep is a backstop, not a delivery mechanism: a swept turn is reported as
  unknown, because it genuinely is. The user may have received the message.
- Ten minutes is generous against Twilio's usual seconds, so a slow-but-real
  callback still wins. Tunable by `ROCKY_STALE_SEND_MS`.
