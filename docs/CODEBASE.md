# Custom code map

Current as of 2026-09-21. Maps the Rocky control plane only — not `node_modules`,
not upstream Hermes, not the removed iRock desktop checkout.
`services/composio-connector` is adapted/vendored connector code under its
preserved upstream license; the surrounding Node control plane is Rocky code.

For *how* things work, read `features/`. This file answers "where does X live?".

## Entrypoints and tenant lifecycle

| Path | Role |
|---|---|
| `src/index.mjs` | HTTP gateway lifecycle, channel selection, admin/status routes, `/files/*` media route, `/connect/composio/callback`, `/internal/cron/delivery`. |
| `src/router.mjs` | The turn pipeline: inbound handling, media collection, prompt assembly, typing heartbeat, deferred output capture, `deliverResponse()` (persist-before-send), committed-response resend sweep, restart recovery. |
| `src/inbound-queue.mjs` | Durable per-tenant scheduler: resolve → yield a cron slot if saturated → FIFO lane per `tenant.id` under a global concurrency semaphore. Coalesces a message into a pending turn. |
| `src/workspace-guardrails.mjs` | Writes and verifies the managed guardrail/persona blocks in a tenant's `AGENTS.md` and `SOUL.md`. Versioned and hashed; a model never authors these. |
| `src/tenant-activation.mjs` | Post-auth activation: prepares the workspace, then announces readiness on the channel. Deduped and awaitable (`whenActivated`). |
| `src/tenant-cli/resources/session.mjs` | `session new` / `session show`. The only caller of `startNewSession`, reached through the grant model like every other capability. |
| `src/tenant-session.mjs` | Owns the OpenClaw session key (`sessionUserFor`) and starts a new session by bumping `sessionEpoch` **and recording `sessionFromSequence`** — the transcript boundary that stops replay and keyword search crossing back into the ended conversation. |
| `src/message-chunks.mjs` | Splits a reply at the provider's body limit (1600 chars) on the largest natural boundary. |
| `src/media-markers.mjs` | Parses OpenClaw's `MEDIA:<path>` convention out of the reply text and into a delivery. |
| `src/outbox.mjs` | Outbound delivery by convention: anything in `workspace/outbox/` is sent, then moved to `outbox/sent/`. |
| `src/agent.mjs` | One tenant turn, 55 lines: connect intent, pending OAuth paste, run the turn. All stateful work crosses the tenant command service. |
| `src/connect.mjs` | `matchConnectIntent()` — anchored matches against the **user's own words**, never the assembled prompt. |
| `src/onboarding.mjs` / `src/provision.mjs` | Sender onboarding, allow-list, tenant creation, workspace seed copy. |
| `src/tenants.mjs` / `src/phone.mjs` / `src/file-lock.mjs` | Opaque tenant IDs, atomic phone/JID index, identity claims, file locks, legacy rekey. |
| `src/cli-home.mjs` | Per-tenant CLI home directories — what keeps each tenant's Claude credentials and synced skills separate. |

## Channels and delivery

| Path | Role |
|---|---|
| `src/channels/port.mjs` | The provider port: required adapter methods, capabilities, normalized inbound/status shapes, and `enforceBodyLimit()` — every outbound text is split to the provider's `maxBodyChars` here, not in an adapter. |
| `src/channels/twilio.mjs`, `src/twilio-channel.mjs`, `src/twilio-webhook.mjs` | Twilio adapter: signature validation against the **configured** public URL, `MessageSid` dedupe, `sendMedia()`, `mediaAuth()`, typing indicator + read receipt, status-callback projection. |
| `src/channels/index.mjs`, `src/channel.mjs` | Adapter selection and the shared channel surface. |
| `src/typing.mjs` | Typing indicator; doubles as the read receipt (blue ticks). Refreshed until the turn replies — it expires after 25 s and a cold start costs ~24 s. |
| `src/whatsapp-format.mjs` | `toWhatsAppText()` — Markdown → WhatsApp markup, applied **before** commit so committed bytes == sent bytes. |
| `src/whatsapp-chunk.mjs` | Cuts a long reply into parts under WhatsApp's body limit, on paragraph/line/word boundaries, keeping a fenced block whole. We split so we own every part's provider id. |
| `src/media-host.mjs` | Signed, expiring `/files/…` links; workspace path resolution is the traversal boundary. |

## OpenClaw runtime and isolation

| Path | Role |
|---|---|
| `src/openclaw/container-paths.mjs` | Every container-side path constant. One place to audit. |
| `src/openclaw/docker-gateway.mjs` | Safe Docker argv, tenant-only bind mounts, loopback port publishing, hardening (`--cap-drop ALL`, `no-new-privileges`, `--pids-limit`, `--memory`), `RUNTIME_TMPFS` with an explicit mode, `imageRunAsIds()`, `ensureMountAccess()`, `containerMountsIntact()`, `hostUidArgs()` (Linux only), gateway-meta merge on rebuild. |
| `src/openclaw/tenant-gateway.mjs` | Gateway supervisor: ports, start/stop/recycle, restart supervision, orphan reconciliation, `inFlight` counting, generation stamping, hibernation (re-armed by **user** activity only). |
| `src/openclaw/tenant-openclaw.mjs` | Per-tenant config build, `claude-cli` selection, run context, turn start, tenant-bound CLI environment. |
| `src/openclaw/tenant-onboarding.mjs` | Ordered, mandatory bring-up. `PHASE.CREATE` / `PHASE.WAKE`, `ensureAgentCredential()`, `ONBOARDING_STEPS`, stops at the first required failure. |
| `src/transcription.mjs` | The speech-to-text seam. Local whisper.cpp was removed 2026-09-21. Delegates to `src/speech/sarvam.mjs` when `SARVAM_API_KEY` is set **and** the caller passes the saved media record (`{path, contentType}`); returns null otherwise, and a voice note is recorded untranscribed. |
| `src/speech/sarvam.mjs` | The Sarvam provider client: `transcribeAudio()` (multipart sync STT) and `synthesizeSpeech()` (binary-stream TTS). Owns the auth header, per-request abort timeout, bounded retries with backoff, first-class retry classification (`SarvamError.retryable`), input size ceiling, TTS character cap, base-directory confinement and atomic hidden-temp writes. Not wired into the turn lifecycle. |
| `src/voice/bland-client.mjs` | The Bland provider boundary: `createCall()` / `getCall()` / `stopCall()` against `https://api.bland.ai/v1`, `Authorization: Bearer`. Injectable `fetchImpl`, hard `AbortSignal` timeout, bounded retries, first-class `BlandError.retryable` **and `BlandError.placementUncertain`** (a timeout or 5xx on create may already have rung a phone). Creation is **single-attempt by default** — Bland documents no idempotency key, so a retried `POST /calls` is a second real call. API key is bearer-only and redacted out of every thrown message; provider detail truncated to 180 chars. Not wired into anything. |
| `src/voice/webhook.mjs` | Bland webhook verification and normalization. HMAC-SHA256 hex over the **raw received bytes** (a parsed-then-restringified body fails, and an already-parsed object throws rather than verifying something else), `timingSafeEqual`, both `X-Webhook-Signature` and `X-Bland-Signature` (Bland's own docs disagree). `withinReplayWindow()` bounds freshness against the timestamp **inside the signed body** — Bland sends no timestamp header. `parseWebhookEvent()` separates the terminal post-call payload from a streamed `category` event and refuses to derive state from the stream's free-text `message`. |
| `Dockerfile.openclaw`, `docker/openclaw/entrypoint.sh` | Pinned OpenClaw/Claude image, `rocky-transcribe` (ffmpeg + whisper.cpp), host credential scrub, tmpfs config rewrite, MCP projection injection. |

## Tenant persistence

| Path | Role |
|---|---|
| `src/tenant-data/open.mjs` | The **only** connection path. Pragmas, `synchronous === 2` assertion, tenant-scoped paths, readonly handles for non-gateway callers. |
| `src/tenant-data/migrations.mjs` | Ordered, checksum-verified migrations 001–009. Append-only. 006 `message_parts`, 007 the waiting states, 008 inbound media jobs, 009 `voice_calls` + `voice_call_events`. |
| `src/tenant-data/store.mjs` | Integrity check, migrate, quarantine-based recovery; seals bodies (policy then encrypt). |
| `src/tenant-data/queue-store.mjs` | Durable queue transactions and **the only place SQL is written**. A test fails the build on `.prepare()` elsewhere in `src/`. |
| `src/tenant-data/delivery-store.mjs` | Persist-before-send, delivery attempts, provider status projection, cron turns created at `response_saved`. |
| `src/tenant-data/context-store.mjs` | `contextNeeded()`, bounded transcript replay, checkpoints, `interruptedTurnPreamble()`. |
| `src/tenant-data/transcript-label.mjs` | The single speaker label for replayed history. Both renderers go through it so they cannot disagree about who authored an outbound message. |
| `src/tenant-data/turn-context.mjs` | Every prompt preamble: audience, tool availability, quoted reply, related context, `needsDisambiguation()`. |
| `src/tenant-data/cron-store.mjs` | Rocky's authoritative cron mirror and duration model; reads OpenClaw's sqlite only to refresh, returns `null` on failure (P8). |
| `src/tenant-data/voice-store.mjs` | The durable outbound-call lifecycle on migration 009. `requestCall()` is idempotent on `call_key`; `LEGAL_VOICE_TRANSITIONS` is the single declaration of the state machine (terminal = declares no successors) and every move is a CAS `UPDATE … WHERE state = ?`. `recordProviderEvent()` dedupes on `fingerprint`, keeps every event as evidence, and projects one only when the transition table allows it — so a late or reordered webhook cannot move a call backwards. Destination, task, summary, transcript and raw event payloads are AEAD-sealed under their own per-column record name. **No model-reachable caller; `approveCall` has no production caller at all.** |
| `src/privacy/aead.mjs` | The single AES-GCM primitive. Writes envelope **v2** (`rocky-vault:v2:` AAD, `_rockyVault`) and still reads v1. `tenant-cli/storage/vault-crypto.mjs` re-exports it. |
| `src/privacy/envelope-migration.mjs` | Re-seals v1 vault **files** as v2. |
| `src/tenant-data/envelope-migration.mjs` | Re-seals v1 transcript **rows** (`messages`, `context_checkpoints`) as v2. SQL stays in this layer. |
| `src/privacy/policy-guard.mjs` | Blocks keys, tokens, OAuth codes, cookies, passwords, OTPs, card secrets before persistence. Ordinary personal data is allowed and encrypted. Findings never carry the matched text. |
| `src/state-backup/backup.mjs` | Verified `db.backup()`, hashed whole-tenant manifest, restore **into staging only**; `openclaw/` excluded by design. |

## Scheduling and cron

| Path | Role |
|---|---|
| `src/speech/sarvam.mjs` | Sarvam STT/TTS provider client: caller-supplied content type, hard timeout, retry classification, size and character caps, atomic TTS write confined to a base directory. Not reachable by a model. |
| `src/speech/voice-reply.mjs` | Decides whether a turn earns a spoken reply and synthesizes it into the tenant outbox. Never throws into the turn; a failure leaves the written reply untouched. |
| `src/voice/ingress.mjs` | Receives Bland callbacks: verifies the signature over the raw bytes, finds the call by its callback reference, records the event. |
| `resources/voice.mjs` | `voice call|status|list` (agent and operator) plus operator-only `stop|reconcile`. No agent or tenant actions: the operator running the command is the human approval. |
| `src/http-body.mjs` | `readParsedBody(req)` — the gateway's request-body reader. Named for its contract: it returns parsed JSON, so callers must not parse it again. |
| `src/wake-scheduler.mjs` | Min-heap of due wakes, shortest-predicted-first with aging, 3-slot cron budget, overrun preemption. One wake carries every job a tenant has due; hibernation waits until OpenClaw's own table shows each has advanced. |
| `src/cron-ingress.mjs` | Token-authed cron result receiver. Tenant resolved from server state, never the payload. Joins the normal persist-then-send path. |
| `src/cron-ingress-listener.mjs` | Dedicated listener on the Docker bridge gateway (the main gateway stays on loopback). |

## Agent-facing MCP

| Path | Role |
|---|---|
| `src/agent-mcp.mjs` | Rocky's own MCP server at `/internal/agent/mcp`: `initialize`, `tools/list`, `tools/call`; the six `AGENT_TOOLS`; `configureAgentDelivery()` binds channel and recipient so the model never names an address. Refused capability returns a tool result with `isError`, not a transport error. |
| `src/inbound-media.mjs` | `mediaKind()`, `transcriptBodyFor()`, `attachmentPreamble()`, `fetchInboundMedia()`. |

## `tenant` control plane

| Path | Role |
|---|---|
| `bin/tenant.mjs` | Operator terminal adapter. Secret input via stdin only; safe-projects output. |
| `src/tenant-cli/args.mjs`, `index.mjs`, `command.mjs` | Parse arguments, execute the one canonical request envelope. |
| `src/tenant-cli/registry.mjs` | Resource/provider registry. Declares `agentActions` per resource — `mcp` (`available, tools, list, status, connect`; `disconnect` deliberately excluded) and `session` (`new, show`). |
| `src/tenant-cli/authorization.mjs` | Grant enforcement, default-deny. Kinds: `operator`, `tenant`, `runtime`, `oauth-callback`, `agent`. |
| `client.mjs`, `result.mjs`, `audit.mjs` | Bound in-process clients, safe display, redacted tenant/platform audit. |
| `resources/auth.mjs` | Claude subscription lifecycle. |
| `resources/mcp.mjs` | Composio-only tenant MCP management, endpoint sync, runtime hydration/revocation. Several accounts per toolkit; `disconnect` needs `--connection` once more than one is connected. |
| `resources/cron.mjs` | `cron list` / `create` / `remove`. Creation execs `openclaw cron add` in the tenant container and refreshes the mirror; the container is woken first because OpenClaw's cron CLI runs via its Gateway. |
| `resources/org.mjs` | Organization bundle validation and manifest rebuild. |
| `resources/user.mjs` | UID migration **and `deprovision`** — dry-run by default; removes index entries, then the container, then archives the directory to `tenants/.deprovisioned/`. Operator-only: the resource declares no `agentActions` and `tenantSelfService: false`. |
| `resources/vault.mjs`, `workspace.mjs`, `runtime.mjs`, `route.mjs`, `state.mjs`, `turn.mjs` | Operator-only health, workspace checks, runtime turn/status, route migration, UID migration, backup/restore metadata, failed-delivery listing. |
| `providers/claude/**` | Official Claude CLI OAuth, credential files, pending callbacks. No API-key path. |
| `providers/composio/**` | Sidecar client, short-lived ES256 assertions, encrypted platform credentials, encrypted tenant state. |
| `providers/codex/index.mjs` | Legacy compatibility only. On hold until Claude is stable in prod; do not extend. |
| `storage/**` | AEAD tenant/platform vault records, durable OAuth pending state. |
| `runtime-credentials.mjs`, `llm-metadata.mjs`, `vault-config.mjs` | Runtime-safe credential checks, metadata only, master-key validation. |

## Organization bundle

| Path | Role |
|---|---|
| `src/mcp/org-bundle.mjs` | Registry schema validation, hashed manifest verify/build, tenant-eligible toolkit selection. |
| `src/mcp/composio-runtime.mjs` | Writes/removes the private runtime-only endpoint+header projection; asserts the canonical config is clean. |
| `org/skills/persona-setup/` | The persona-drafting skill, loaded through `skills.load.extraDirs` — no fork, no version pin. `reference/` keeps the stock OpenClaw defaults as source material. |
| `org/mcp/registry.json` | Six approved toolkits with pinned `authConfigId`: Gmail, Google Calendar, Google Drive, Asana, Linear, Fireflies. |
| `org/policy/tools.json` | Architecture booleans. **No code reads it; it is not an enforcement point.** |
| `org/templates/workspace/AGENTS.md` | The managed `ROCKY-GUARDRAILS` block (audience, delivery, tool honesty, capability honesty, provenance, state claims, justification). |
| `org/templates/workspace/SOUL.md` | The `ROCKY-PERSONA` block — BugleRock default track. Replaced by the persona skill on the personal track. |
| `org/templates/**`, `org/workspace/**` | Shared instructions, organization content, legal templates. |
| `org/manifest.json` | Hash manifest for the bundle. Regenerate only with `tenant org build`. |

## Connector sidecar

| Path | Role |
|---|---|
| `services/composio-connector/src/rocky_connector/app.py` | Internal FastAPI service: toolkit, connection, MCP-resolution endpoints. |
| `.../identity.py`, `.../config.py` | ES256 assertion verification; secret/registry settings. |
| `.../domain.py`, `.../ports.py`, `.../schemas.py` | Domain types, boundaries, HTTP schemas. |
| `.../service.py` | Allow-list, idempotency/audit orchestration, endpoint validation. |
| `.../composio_gateway.py` | Composio SDK adapter: stable `acct:<tenant>` scope, Connect Link, one account per toolkit, one combined MCP endpoint. |
| `.../store.py` | Postgres idempotency and audit store. No provider credentials. |
| `docker-compose.yml` | Sidecar + Postgres. The Node gateway stays host-managed. |

## Deploy

| Path | Role |
|---|---|
| `deploy/push.sh` | `rsync -az --delete-after` with the exclude file. |
| `deploy/rsync-exclude.txt` | `platform/`, `tenants/`, `.env.local`, `.env`, `ops/`, `logs/`, `baileys_auth/`. Pinned by a test. |
| `deploy/rocky-gateway.service` | systemd unit; `TimeoutStopSec=40` exceeds the drain grace period (P7). |
| `scripts/compose.mjs` | Loads local environment migration rules, then invokes Docker Compose without exposing values. |
| `docs/ROCKY-PRODUCTION-CUTOVER.md` | Operator runbook for the deferred live infrastructure rename and rollback. |
| `docs/PATTERNS.md` | P1–P12. Project-agnostic engineering patterns, in `Ask / Why / Do / Prevents` form. |
| `docs/PATTERNS-durable-work.md` | Nine rules for long-running work that pauses for a human and must survive a restart: leases vs capacity, two-step completion, content-hashed approval, uniqueness, conditional transitions, notifications, auto-created dependencies, unset defaults, state naming. Self-contained — no cross-references. |
| `docs/specs/control-plane/` | Spec suite for the bot control plane, phases 1–3: compare-and-swap, waiting states, leases, the reconcile sweep, the step ledger, host-side step verification, plus the retroactive decision entries. Build-time artifacts; deleted once the slices land. |
| `docs/specs/PHASES-4-7-carry-forward.md` | What the phase 4–7 specs (routing, approvals, cron, Class A agents) must cover: settled constraints, what is already built, and the open questions. |
| `docs/research/2026-09-23-openclaw-openmuse-findings.md` | Why the Bot control plane is Rocky's and not OpenClaw's: 21 OpenClaw reliability findings, 20 OpenMuse patterns, each with its brief and verification status. |

## Tests

| Group | Role |
|---|---|
| `test/setup.mjs`, `test/helpers.mjs`, `scripts/test.mjs` | Isolated roots, helpers, cross-platform runner. |
| `test/no-undefined-identifiers.test.mjs` | Fails the build on an undefined identifier in `src/`. Written after three such bugs shipped. |
| `test/*tenant*`, `*isolation*`, `*docker*`, `*credential*`, `*mcp*` | Authorization, mounts, projection, vault secrecy, MCP contracts — against **real containers**. |
| `services/composio-connector/tests/**` | Sidecar identity, service, adapter, HTTP. |
| `test/GATES.md` | Gates that remain manual. |

## Retained without a caller

| Path | Why it stays |
|---|---|
| `src/mcp/openclaw-native.mjs` | `runNativeMcpCommand` drives OpenClaw's own `mcp` CLI inside the container. The Composio sidecar superseded it and nothing calls it today, but it is kept deliberately as the native path back if the sidecar is ever bypassed. Do not treat it as dead in a future sweep. |

## Removed 2026-09-22

Baileys and the stale-code sweep. Do not re-add as aliases.

| Path | Why |
|---|---|
| `src/baileys-channel.mjs` + 3 tests | Twilio is the only transport; `ROCKY_CHANNEL` defaults to `twilio` and an unknown channel throws. |
| `vendor/noop-eslint-config/` | Existed only to stop npm resolving Baileys' git-URL eslint config. |
| `src/product-env.mjs` + test | `RIFT_*` → `ROCKY_*` env shim; no `RIFT_*` var remains anywhere. |
| `src/tenant-data/search-store.mjs` + test | Its caller `relatedContextPreamble` was deleted. |
| `src/openclaw/openclaw-singleton.mjs` + test | Single-gateway era; each tenant has its own container. |
| `test/security-profile.test.mjs` | Fully subsumed by `config-security.test.mjs`. |
| `templates/` (repo root) | Dead duplicate — provisioning reads `org/templates/workspace/`. |
| `public/connect/llm/` | Its endpoint returns a hardcoded 410. |
| `commit-plan.sh` | Spent one-shot staging script. |
| `src/google/`, `src/oauth/`, `src/vault/` | Empty directories. |

## Deliberate removals — do not re-add as aliases

`src/google/tools.mjs`, `src/oauth/google.mjs`, `src/oauth/claude.mjs`,
`src/llm-auth.mjs`, `src/mcp/tenant-mcp.mjs` — direct-provider, static-token and
generic MCP paths.

## Persistent layout

```text
tenants/<uid>/
  tenant.json  workspace/{,inbox/}  openclaw/{,.home/}  cli-home/claude/
  data/tenant.sqlite   vault/   audit.jsonl
platform/{vault/,runtime-secrets/composio/}     # host-only, git-ignored, never deployed
org/**                                          # versioned, mounted read-only
```

`data/tenant.sqlite` is schema **v7**: transcript, turn ledger, delivery
attempts, cron mirror, cron duration model, reply reference, attachments,
outbound message parts, and the three waiting states on `turns`.
Corrupt files are quarantined beside it as `data/corrupt-<timestamp>/`.
