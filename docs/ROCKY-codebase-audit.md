> **Historical.** A point-in-time document, kept for its reasoning. It is *not* a
> description of the current code — see `docs/features/`, `docs/CODEBASE.md`, and
> `docs/DECISIONS.md` when they disagree.

> **SUPERSEDED, 2026-09-18.** Point-in-time audit from 16 Sep, retained for its
> architecture-direction analysis and target repo structure only.
>
> - Security, CLI-ownership and defect findings are **stale** — superseded by
>   `ROCKY-requirements-verification.md`. Most listed defects are fixed.
> - Container/warm-pool statements are **wrong** as of 18 Sep — containers are
>   always-on and host-supervised. See `DECISIONS.md` and `SPEC-phase3c` §1.4.
> - Authority order is `DECISIONS.md` → the numbered `SPEC-*` documents →
>   `backlog.md`. This file outranks nothing.

# ROCKY codebase audit — full src/ inspection

Scope: every file under `src/`, plus `bin/`, `docker/`, `scripts/`, config and repo
root. `test/` excluded by instruction. Analysis only — no code changed.

Graph: `graphify update . --no-cluster` (code-only, no LLM). 670 nodes / 1831 edges.
Import graph rebuilt independently by AST scan to verify orphans.

**Bottom line:** the fork is a working *Rocky* product — Baileys-channel,
Google-REST-first, single-tenant-ish assumptions — with a ROCKY tenant/CLI layer
grafted on top. The two layers disagree in several places, and the ROCKY
requirements (Twilio, MCP-first tools, CLI-owned credentials, encrypted vault)
are largely **not implemented**. This is not a polish pass; it is an unfinished
architecture transition.

---

## 0. Direct answers

**0.1 — Is `llm-auth.mjs` needed?** Mostly no. 175 lines, imported by 7 modules.
Under ROCKY, Claude credentials live in `cli-home/claude/.credentials.json` owned
by Claude CLI. What survives is roughly 30 lines: `anthropicReady()` and the env
strip. `FORBIDDEN_ANTHROPIC_SECRET_KEYS` is a defensive filter compensating for a
design that should not write those keys at all — delete the writers, delete the
filter.

**0.2 — Why `saveLlmAuth({..., anthropicApiKey: null, claudeCodeOauthToken: null})`?**
It is a migration eraser: passing `null` triggers `delete next[k]` so old vault
files shed legacy token fields on next login. Legitimate intent, wrong mechanism —
it runs on every login forever to clean a state that should be purged once by a
migration step. Ad-hoc.

**0.3 — What are `pendingDir` / `pendingPath` / `readPendingFile` /
`tenantIdsOnDisk` / `filesForTenant` / `findPendingFile` / `writePendingFile`?**
Not routing. This is a hand-rolled **single-use OAuth state store** replacing the
in-memory `Map`. `findPendingFile` scans *every* tenant directory looking for a
matching state file — O(tenants) filesystem stats per lookup, and it is duplicated
almost verbatim in `llm-auth.mjs`. Should be one `PendingAuthStore` module with a
tenant-scoped key, not a directory sweep.

**0.4 — Is `runTenantAction` per-tenant isolation?** No. It is a command
dispatcher. It takes `--tenant` from the caller and, as written, performs no
authorization. Isolation comes from the per-tenant container and mounts, not
from this function.

**0.5 — Does OpenClaw support an OpenAI CLI?** No. Confirmed from docs:
*"OpenAI Codex agent runs use the Codex app-server harness through `openai/*`.
There is no bundled `codex-cli` backend."* Bundled CLI backends are `claude-cli`
and `google-gemini-cli`. So the Codex paths here can never be a CLI backend —
scope OpenAI as app-server-harness later, or drop it.

**0.6 — Are we maintaining Fernet / vault encryption?** **No. There is no
encryption anywhere in the codebase.** A grep for `fernet|createCipher|encrypt|
scrypt|aes-` across `src/` returns only unrelated Baileys decrypt logging. The
vault is plaintext JSON at `tenants/<id>/vault/*.json`, mode `0600`. Hermes
encrypted provider tokens at rest with Fernet (`utils/crypto.py`). **This is an
unimplemented regression**, already flagged as D5/R8 in the migration plan.

**0.7 — One Docker image or many?** One. `DEFAULT_OPENCLAW_IMAGE` is pinned to
`rocky-openclaw:2026.7.1-2` (the pin at time of audit; now `2026.7.33`) and every
tenant container runs that same image;
per-tenant state arrives purely through bind mounts. **Your assumption is
correct** — no per-tenant images, no per-tenant disk cost beyond the tenant dir.

**0.8 — One container for all users, or one per user?** One per tenant.
`dockerContainerName()` → `rocky-oc-<instance>-<tenantId>`, started on demand by
the warm pool, idle-evicted. Correct for ROCKY.

**0.9 — Is the vault inside or outside the container?** Outside, correctly.
`buildDockerRunArgs` mounts exactly four paths — `workspace`, `openclaw`,
`cli-home/claude`, and `org` read-only. `vault/` is deliberately **not** mounted,
so the model runtime cannot read provider credentials. This is the one piece of
the ROCKY security model that is fully implemented.

**0.10 — If the CLI runs inside the container, how does it write the vault?**
It does not, and must not. The CLI is a host-side binary (`bin/tenant.mjs`) that
writes `tenants/<id>/vault/`. Nothing bundles it into the image. Keep it that way:
the moment the CLI is reachable from inside the container, the vault-exclusion
mount becomes decorative.

**0.11 — `entrypoint.sh` lines 25-40.** Two defensive scrubs, both correct in
intent: `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN`
(they rank above `.credentials.json` and would suppress refresh), then an inline
Node heredoc deleting the same keys from `settings.json`. The logic is right; a
20-line Node program embedded in a shell string is not — it is unlintable,
untestable, and duplicated in `oauth/claude.mjs`.

**0.12 — Why is `baileys_auth/` there, and where is `twilio-channel.mjs`?**
`baileys_auth/` is a live Baileys linked-device session store. **There is no
Twilio code anywhere in the repo** — zero matches for `twilio` across `src/`,
`bin/`, `docker/`, `scripts/`, `package.json`. The Twilio channel is entirely
unbuilt.

**0.13 — Does `agent.mjs` routing match ROCKY's assumptions?** No — see §2.1.
It is built on Rocky's assumption that Google is served by direct REST and OpenClaw
is a fallback turn-runner. ROCKY requires MCP-first.

**0.14 — Is `tenants/` a test artifact?** Yes, and it is dirty. 28 directories,
all phone-keyed (`15551234567`, `1568472407930`, …), none matching
`br_[a-f0-9]{12}`. None are real. They must not ship, and the migrator must not
treat them as customer data.

---

## 1. File-by-file verdict

Orphans (no importer in `src/`, `bin/`, `scripts/`): `cli-mock.mjs`,
`baileys-channel.mjs` (loaded dynamically via the channel factory), `index.mjs`
(process entrypoint — expected).

| File | LOC | Verdict |
|---|---:|---|
| `index.mjs` | 505 | **Rewrite.** One 300-line `http.createServer` with manual `if (url === …)` routing: signup pages, OAuth callbacks, admin endpoints, channel bootstrap. No router, no middleware, no separation. |
| `baileys-channel.mjs` | 678 | **Delete for prod.** Largest file in the repo. Dev-only once Twilio lands. |
| `agent.mjs` | 135 | **Rewrite.** See §2.1. |
| `connect.mjs` | 307 | **Delete.** Regex intent matching (`matchConnectIntent`, `matchGoogleToolIntent`) that exists only to bypass MCP. |
| `google/tools.mjs` | 189 | **Move.** Direct Google REST. Becomes an MCP connector, not an agent shortcut. |
| `oauth/google.mjs` | 166 | **Move behind CLI** as `tenant account login --provider google`. |
| `oauth/claude.mjs` | 351 | **Split.** Keep the PKCE exchange; move pending-state and credential-write out. |
| `llm-auth.mjs` | 175 | **Reduce to ~30 lines.** See §0.1. |
| `mcp/tenant-mcp.mjs` | 90 | **Rewrite.** Hard-coded to `['gmail','calendar']`, servers written `enabled: false`. |
| `tenant-cli/user.mjs` | 495 | **Extract.** 80% is one-time UID migration. Does not belong in a shipped product. |
| `tenant-cli/{index,args,audit,auth,route,runtime}.mjs` | 385 | **Keep, restructure.** See §3. |
| `tenant-cli/stub.mjs` | 3 | Placeholder for `account`/`vault`/`mcp`. |
| `openclaw/tenant-openclaw.mjs` | 780 | **Keep, split.** Config generation + env building + turn execution in one file. |
| `openclaw/tenant-gateway.mjs` | 627 | **Keep.** Warm pool. Solid. |
| `openclaw/docker-gateway.mjs` | 206 | **Keep.** Mounts and `buildDockerRunArgs` are correct. |
| `openclaw/openclaw-singleton.mjs` | 165 | **Review.** Detects and kills foreign OpenClaw processes by scanning `ps`. Aggressive; risky on a shared host. |
| `tenants.mjs` | 294 | **Keep.** Most-depended-on module (15 importers). |
| `config.mjs` | 297 | **Keep, rename.** 48 ROCKY references, the highest in the repo. |
| `provision.mjs` | 118 | **Keep.** Needs the idempotency fix. |
| `onboarding.mjs` | 238 | **Rewrite.** Baileys-coupled state machine. |
| `inbound-queue.mjs` | 116 | **Keep.** In-memory; needs durability before cutover. |
| `cli-home.mjs` | 113 | **Keep.** Fix the login-detection fallback. |
| `router.mjs` / `channel.mjs` / `typing.mjs` | 94 | **Keep.** Clean seams. |
| `phone.mjs` / `paths.mjs` | 40 | **Keep.** |
| `api-auth.mjs` / `ops-alert.mjs` / `load-env.mjs` | 194 | **Keep.** |
| `cli-mock.mjs` | 22 | **Delete.** Orphan. |

---

## 1b. Findings that only surfaced on a full read

The first pass judged several files from diffs, LOC and the import graph. Reading
them line by line produced nine defects that were not visible any other way.

**F1 — HIGH — Google refresh tokens are written world-readable.**
`oauth/google.mjs:134` — `await fs.writeFile(file, JSON.stringify(next, null, 2))`
with **no `mode`**, so the file lands at the process umask (typically `0644`).
`llm-auth.mjs:54` writes its sibling vault file with `{ mode: 0o600 }`. The same
`vault/` directory therefore holds one hardened and one exposed credential file,
and the exposed one carries the Google **refresh** token.

**F2 — HIGH — a third OAuth pending store, still in memory.**
`oauth/google.mjs:25` — `const pending = new Map()`. The Claude and LLM stores were
moved to disk; Google was not. A gateway restart mid-Google-connect strands the
user with a dead callback. Three stores, two implementations, one of them stale.

**F3 — HIGH — the web OAuth path bypasses the tenant CLI entirely.**
`index.mjs:243-270` (`POST /api/connect/claude`) calls `completeClaudeOAuthFromPaste`
and `recycleTenantGateway` directly. The WhatsApp path routes through
`runTenantAction`. So the same flow has two implementations, and **web completions
produce no audit record** — `appendTenantAudit` is never reached.

**F4 — HIGH — `POST /api/connect/llm` accepts a raw OpenAI API key over HTTP**
(`index.mjs:274-310`) and hands it to `saveLlmAuth`, landing in plaintext in the
vault. No `requireApiAuth`; protection is knowing `state`. Directly contradicts
the "credentials never transit chat/HTTP" rule.

**F5 — MEDIUM — prod can silently start on a mock channel.**
`index.mjs:57-66` — `createChannel()` catches a Baileys import failure and returns
`MockChannel`. `validateStartupSecurity()` (`config.mjs:197`) checks runtime,
fallback, allowlist and API token, but **never checks `channelKind`**. A prod
gateway can therefore boot, report `ok: true` on `/health`, and accept no real
traffic.

**F6 — MEDIUM — the MCP config points at Developer-Preview endpoints and is
disabled by design.** `mcp/tenant-mcp.mjs:44-60` writes `gmail` and `calendar`
servers at `https://gmailmcp.googleapis.com/mcp/v1` with
`enabled: false, // Requires Google Workspace Developer Preview — use REST fallback`.
This is not an incomplete migration — MCP was evaluated, found unavailable, and
deliberately replaced by the REST bypass. Rebuilding MCP-first means picking
different servers, not enabling these.

**F7 — MEDIUM — a hand-rolled natural-language date parser.**
`connect.mjs:74-120` — `parseMeetingTime()` is ~45 lines of regex for "tomorrow
5pm", with a hardcoded default hour of 17 and a D/M-vs-M/D heuristic. Pure Rocky
legacy: this is the model's job, and it will silently mis-schedule meetings.

**F8 — LOW — dead branching in `matchConnectIntent`.** `connect.mjs:26-32` — all
three Google branches return the identical `{ services: ['gmail','calendar'] }`,
including the one guarded by `if (t.includes('calendar') || t.includes('meet'))`.

**F9 — LOW — `openclaw-singleton.mjs` kills processes by `ps` scraping.**
`ensureExclusiveOpenclawGateway()` runs `ps -Ao pid=,args=`, regex-matches any
command containing `openclaw` plus `gateway`, and `SIGTERM`s the survivors. Gated
behind `ROCKY_OPENCLAW_KILL_FOREIGN`, but on a shared host it can kill another
tenant's — or another product's — gateway.

**Confirmed clean on read:** `api-auth.mjs` (timing-safe compare, fails closed
when unconfigured), `router.mjs`, `channel.mjs`, `typing.mjs`, `load-env.mjs`
(never overrides existing env), `warmGatewayStats()` (does not leak the gateway
token), and `validateStartupSecurity()`'s prod guards, which correctly force
Docker, forbid host CLI fallback, and require an allowlist plus API token.

---

## 2. Issue catalogue

### 2.1 Architecture drift — ROCKY requirements not implemented

**A1 — No Twilio channel at all.** Zero occurrences of `twilio`. The decision
record says "keep the existing Twilio number; Baileys is not the production
transport." Baileys is currently the *only* transport, wired through `index.mjs`,
`channel.mjs`, `onboarding.mjs`, `config.mjs` and `baileys_auth/`.

**A2 — Tools bypass MCP by design.** `agent.mjs:87-113` matches a Google intent
by regex and calls REST directly, with the comment *"On match, never fall through
to OpenClaw."* `mcp/tenant-mcp.mjs:39` hard-codes `services = ['gmail','calendar']`
and writes them `enabled: false`. The MCP path — the core ROCKY requirement — is
not merely incomplete, it is deliberately short-circuited.

**A3 — Vault is plaintext, and inconsistently permissioned.** No encryption
anywhere (§0.6). Worse, the two writers disagree: `llm-auth.mjs` uses `0600`,
`oauth/google.mjs` uses the default umask (F1). Regression from Hermes, which
encrypted provider tokens at rest with Fernet.

**A4 — AI login is not mandatory before use.** Onboarding provisions a tenant and
starts turns; Claude connection is prompted lazily on failure. Requirement is that
setup completes — including AI login — before the agent is reachable.

**A5 — Credentials are not structurally unreachable by the AI.** The mount
exclusion is right, but `runTenantAction` has no authorization layer, so any
caller may pass any `--tenant`. Safe today only because `agent.mjs` passes a
server-resolved id.

### 2.2 Modularity and ad-hoc logic

**B1 — Inline provider lists.** `['microsoft','asana'].includes(provider)`,
`['hermes','openclaw'].includes(backend)`, `services = ['gmail','calendar']`,
`plan === 'codex'` scattered across `agent.mjs`, `route.mjs`, `tenant-mcp.mjs`,
`tenant-openclaw.mjs`. A typo fails silently. Needs one provider registry.

**B2 — Migration code shipped in the product.** `tenant-cli/user.mjs` is 495 lines,
the bulk being one-time UID rekeying with manifest parsing and path validation.
Belongs in `scripts/migrations/`, deleted after the pilot.

**B3 — Three pending-auth stores, two implementations.** `oauth/claude.mjs` and
`llm-auth.mjs` each carry a near-identical file-based store that sweeps every
tenant directory per lookup; `oauth/google.mjs` still uses an in-memory `Map`
(F2). One `PendingAuthStore` module, tenant-scoped key, no directory sweep.

**B3b — Two implementations of Claude OAuth completion.** WhatsApp goes through
`runTenantAction`; the web endpoint calls the oauth module directly (F3). Whatever
the CLI is supposed to own, it does not yet own.

**B4 — Duplicated credential scrubbing.** The same three-key delete exists in
`entrypoint.sh` (twice — `unset` and Node heredoc) and `oauth/claude.mjs`.

**B5 — Inline Node programs inside shell heredocs.** `entrypoint.sh` embeds two
multi-line Node scripts (settings scrub, `openclaw.json` path rewrite). Unlintable,
untestable.

**B6 — Error strings inline in control flow.** `agent.mjs:95-110` builds
multi-paragraph user-facing guidance, including a Google Cloud Console URL scraped
out of an exception message, inside a catch block.

**B7 — Hand-rolled CLI arg parsing.** `tenant-cli/args.mjs` is a 31-line manual
parser: no types, no validation, no help, no subcommand discovery. `--dry-run=false`
silently does not work because the string `"false"` fails a `!== false` check.

### 2.3 Naming

**C1 — 166 `rocky` references** across `src/`, `bin/`, `docker/`, `scripts/`,
`public/`, `templates/`, `ops/`. Highest concentrations: `config.mjs` (48),
`index.mjs` (13), `docker-gateway.mjs` (10).

**C2 — 30+ `ROCKY_*` environment variables** are public API. Renaming is a breaking
change for any existing deployment and needs a compatibility window reading both
prefixes.

**C3 — Other surfaces:** `rocky.config.json` / `rocky.config.example.json`,
container prefix `rocky-oc-*`, image tag `rocky-openclaw:*`, package name, and the
`/home/rocky` container user.

### 2.4 Correctness defects

Carried forward from the logic review, all still open:

| ID | Severity | Issue |
|---|---|---|
| H1 | High | Stale-lock break can unlink another process's lock (`tenants.mjs`) |
| H2 | High | `--code` passed as CLI flag → shell history and `ps` |
| H3 | High | `bin/tenant.mjs` prints `authorizeUrl`/`pastePageUrl` unredacted |
| M1 | Med | `anthropicReady` requires a refresh token; missing one reads as disconnected |
| M2 | Med | Phone-directory fallback can route a live user into a stale tenant |
| M3 | Med | `claudeCliLoggedIn` true for any non-empty config dir |
| M4 | Med | Double-provision window: `signupFromWeb` bypasses the per-phone queue |
| M5 | Med | `redactParams` matches key names, not value shapes |
| M6 | Med | `CLAUDE_CONFIG_DIR` silently unset on the host-fallback branch |
| M7 | Med | `routes.json` read-modify-write has no lock — and it is the cutover switch |
| M8 | Med | `route rollback` splices history, so rollback is not repeatable |
| L1-L5 | Low | Spoofable audit actor; `listTenants` misses jid-only tenants; migrator aborts on UID collision; `--dry-run=false` ignored; dead `base` binding |

### 2.5 Repo hygiene

**E1 — `tenants/` holds 28 test directories** (§0.14).
**E2 — `baileys_auth/`** is a live session store in the repo root.
**E3 — `vendor/`, `ops/`, `public/`, `docker-compose.yml`** unreviewed for ROCKY fit.
**E4 — `graphify-out/`** now generated; add to `.gitignore`.

---

## 3. Target structure

```
rocky/
  bin/rocky.mjs                 # thin entry; commander
  packages/
    tenant-cli/                 # standalone, reusable, zero app imports
      src/{commands,contracts,audit,redact}/
      package.json              # publishable
  src/
    channels/{index,twilio,baileys}.mjs   # baileys = dev only
    core/{tenants,provision,paths,phone,config}.mjs
    runtime/{openclaw-config,gateway,docker,warm-pool}.mjs
    connectors/                 # MCP servers: google, microsoft, asana, bland
    vault/{store,crypto}.mjs    # encryption lives here
    providers/registry.mjs      # single source for provider/service/backend lists
    http/{server,routes}.mjs
  scripts/migrations/           # UID rekey — deleted after pilot
  org/{skills,templates,workspace,mcp,policy}/
  tenants/                      # gitignored, runtime only
```

Two rules that fix most of §2.2: the CLI package may not import from `src/`
(that is what makes it reusable), and every provider/service/backend list comes
from `providers/registry.mjs`.

---

## 4. Recommended order

1. **Decide scope.** This is a fork-and-rewrite, not a cleanup. Roughly 2,000 of
   ~5,900 `src/` lines are Rocky-specific and slated for deletion.
2. **Fix the data-loss defects** (H1, M4, M7, M8) — they bite whatever else changes.
3. **Extract the CLI to `packages/tenant-cli` and move it to commander.** Do this
   before adding `account`/`vault`/`mcp`, so the reusable shape is set first.
4. **Build the vault with encryption**, then move Google/Microsoft/Asana OAuth
   behind `tenant account login`. Delete `oauth/google.mjs` and `connect.mjs`.
5. **Prove one MCP tool end-to-end** through the bundle bridge, then delete the
   REST bypass in `agent.mjs`.
6. **Build the Twilio channel** behind the existing channel seam.
7. **Rename ROCKY → ROCKY** last, in one mechanical pass, with a dual-prefix env
   compatibility window.
8. **Delete** `cli-mock.mjs`, `tenants/*`, `baileys_auth/`, and move
   `user.mjs`'s migration half to `scripts/migrations/`.

Rename last because every earlier step deletes files — renaming first means
renaming code that is about to be removed.
