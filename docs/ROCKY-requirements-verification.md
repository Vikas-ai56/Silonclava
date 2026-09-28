> **Historical.** A point-in-time document, kept for its reasoning. It is *not* a
> description of the current code — see `docs/features/`, `docs/CODEBASE.md`, and
> `docs/DECISIONS.md` when they disagree.

# ROCKY requirements — verification

Method: four independent investigation streams (auth flow, Google/vault, modularity,
and an adversarial counter-position tasked with disproving the critical findings),
plus first-hand verification of every load-bearing claim. Suite executed.
Working tree, ~871 uncommitted insertions. Analysis only — no code changed.

**Supersedes the security and CLI-ownership sections of `ROCKY-codebase-audit.md`,
which are stale.** The architecture-direction sections of that document stand.

---

## Verdict

**The Claude path is done properly. Everything beside it is not.**

One seam — Claude auth — now has authorization, audit, durable single-use OAuth
state, a single authoritative credential file, and contract tests. The same
discipline has not been applied to Google, to the web OAuth route, to org content,
or to the module boundaries. The result is a codebase with one finished vertical
and several unfinished ones, which reads as inconsistent rather than incomplete.

| Requirement | Verdict | Decisive evidence |
|---|---|---|
| Auth via tenant CLI | **PARTIAL** | Claude: yes (`agent.mjs:36,66`). Google: no caller anywhere routes through the CLI |
| New user must connect Claude first | **PARTIAL** | Gate exists (`tenant-openclaw.mjs:405-418`, called `:680`) but sits on the model path, not onboarding; Google REST bypasses it entirely |
| AI never reaches credentials | **PARTIAL** | Vault excluded and env clean; but `.credentials.json` is mounted `:rw` into the tool container |
| Google auth behind the CLI | **NOT MET** | `tenant account` throws (`stub.mjs:2`); `auth.mjs:13-19` rejects any provider ≠ claude |
| Org packs | **NOT MET** | `org/` is empty (0 files); nothing reads `ORG_DIR` except the mount |
| No inline / ad-hoc logic | **NOT MET** | Provider literals scattered; `user.mjs` ships 495 lines of one-time migration |
| CLI reusable / commander | **NOT MET** | `commander` is not a dependency; arg parsing hand-rolled in `args.mjs` (31 lines) |
| Encrypted vault | **NOT MET** | Zero cipher/KDF call sites in the entire repo |
| Twilio channel | **NOT MET** | Zero occurrences of `twilio` anywhere |
| MCP-first tools | **NOT MET** | REST bypass is live *and pinned by a passing test* |
| ROCKY → ROCKY | **NOT MET** | **224** references; **49** `ROCKY_*` env vars, plus image tag, container prefix, lockfiles and user-visible copy |

---

## 1. What is genuinely done — and was previously mis-reported

The earlier audit asserted that `runTenantAction` performed no authorization and
that the audit actor was spoofable. **Both claims were false against the current
tree.** `tenant-cli/index.mjs:9-21`:

```js
function authorizeTenantAction(resource, options, authorization) {
  if (authorization?.kind === 'operator') return;
  const target = options.tenant ? String(options.tenant) : null;
  if (authorization?.kind === 'tenant' && target &&
      String(authorization.tenantId) === target && resource !== 'user') return;
  throw new Error(`Not authorized for ${resource} ${actionLabel(options)}`);
}
```

First statement of the dispatcher. Default-deny. Tenants pinned to their own id.
`user` (the migration surface) is operator-only. `--actor` is rejected outright
(`:72-74`). Proven at `tenant-cli.test.mjs:118-155`.

Also fixed and verified: ownership-checked index lock (token + dev + ino),
`bin/tenant.mjs` refusing `--code` in argv and projecting stdout through a
redactor, single authoritative credential file with the legacy duplicate deleted
on every login, `FORBIDDEN_ANTHROPIC_SECRET_KEYS` making vault poisoning
structurally impossible, image pinned to `rocky-openclaw:2026.7.1-2` (pin at time
of verification; now `2026.7.33`).

**The largest single improvement, which the earlier audit missed entirely:** the
working tree deleted a ~35-line entrypoint block that read
`/tenant/vault/llm-auth.json` and exported `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` into the model's process, and replaced the whole-tenant
`-v …:/tenant` mount with four narrow mounts. That was the real vulnerability.

Suite: **141 tests, 139 pass, 0 fail, 2 skipped.** `test/GATES.md` correctly
states that green contract tests do **not** prove Gate A or Gate B.

---

## 2. Credential exposure — corrected analysis

`oauth/claude.mjs:245` writes the credential to `tenantClaudeConfigDir(tenantId)`
= `tenants/<id>/cli-home/claude/.credentials.json` (plaintext `accessToken` +
`refreshToken`). `docker-gateway.mjs:151` mounts **that exact path** `:rw` into
the container where the agent's Bash/Read tools execute with
`cwd=/tenant/workspace`. Verified first-hand; a real tenant file exists there.

**This is not forced by `claude-cli`.** OpenClaw's own documentation states it
forwards saved subscription credentials to the CLI *"through a protected file
descriptor"* — deliberately not a readable path — and that the backend keeps
native tools under host control via `PreToolUse`. Rocky bypasses that mechanism by
seeding the credential file itself.

**Fix direction:** keep Rocky's WhatsApp PKCE flow exactly as-is; change only the
final handoff, so the minted token goes into OpenClaw's own credential store
(`openclaw models auth … --agent <tenantId>`) rather than into a bind-mounted
file. The `cli-home/claude` mount then drops out of the mount list.

*Confidence: high on the exposure (verified three ways), medium on the fix
mechanism (documented behaviour, not yet exercised against the pinned package —
fold into Gate B).*

---

## 3. Auth gate — where it actually sits

`assertCliReady` (`tenant-openclaw.mjs:405-418`) hard-returns login help before
any gateway work. So **the model is unreachable without a valid access token.**
But:

- The onboarding state machine has no gate. `provision.mjs:103` hardcodes
  `state: 'ACTIVE'`; the tenant is ACTIVE and reachable before connecting Claude.
- **`agent.mjs:89-115` returns before `runOpenclawTurn`.** A tenant who connected
  Gmail but never Claude can read inbox, **send mail**, and create calendar
  events. `assertCliReady` is never reached. This is the bypass that matters.
- Container provisioning happens before the gate.
- Failure returns a *string*, so nothing upstream can distinguish an
  authenticated turn from a rejected one — no metric, no state transition.

**Self-inflicted race on the happy path:** every unauthenticated turn calls
`cliLoginHelp` → `createClaudeOAuthSession`, which deletes all prior pending files
(`oauth/claude.mjs:99`). A user who opens the link then sends any message while
approving in the browser destroys their own in-flight code.

---

## 4. Google — none of the Claude hardening was applied

| Aspect | Claude path | Google path |
|---|---|---|
| Routed via CLI | yes | **no** — `connect.mjs:223`, `index.mjs:193-201` |
| Authorization | `authorizeTenantAction` | **none** |
| Audit | `appendTenantAudit` | **none** |
| Pending state | on-disk, 0700/0600, single-use | **in-memory `Map`** (`google.mjs:25`) |
| File mode | `0600` | **none** → umask, observed `0644` on disk |
| Content | plaintext | plaintext |

The `0644` file holds a Google **refresh token** — effectively non-expiring,
scoped to `gmail.send`, `gmail.readonly`, `gmail.compose`, `calendar.events`. It
is the single outlier in a repo otherwise disciplined about `0600`.

`tenant account login --provider google` is blocked twice: `account` hits the
stub, and `auth.mjs:13-19` rejects any provider that is not `claude`.

**There is no Microsoft or Asana code in the repo at all** — zero hits for
`microsoft|outlook|graph\.microsoft|asana|azure`. The migration plan treats these
as ports; there is nothing to port.

---

## 5. Modularity

**Genuinely well factored** (worth preserving): `tenant-cli/*` as single-purpose
modules; `buildDockerRunArgs` as a pure argv builder extracted specifically for
testing; `claimTenantIdentity({idFactory})` with injected generator;
`withTenantIndexLock(mutator)` as a transaction boundary; `publicGatewayResult`
token stripper; `channel`/`router`/`typing` seams; `api-auth` (timing-safe, fails
closed).

**Genuinely poor:** `index.mjs` (505 lines, one `createServer` with manual path
matching); `tenant-openclaw.mjs` (780 lines — config generation, env building,
turn execution and SSE parsing in one file); `user.mjs` (495 lines, mostly
one-time UID migration shipped inside the product); `connect.mjs` (307 lines of
regex intent matching plus a hand-rolled natural-language date parser);
`baileys-channel.mjs` (678).

**No central registry exists.** 42 hardcoded literals across control flow — no
`providers/`, no `registry.mjs`, no `connectors/`, no constants module. The worst
offenders: `['gmail','calendar']` retyped in 6 places, `plan === 'codex'` re-derived
in 8, the three Anthropic env-key names hardcoded in **4** separate places (one of
them inside a shell string), and the Claude credential filenames in 6.

**Blocking CLI extraction — worse than a simple import list.** 14 outward imports
to 8 targets, but the real blocker is transitive: `auth.mjs` → `cli-home` →
`oauth/claude` → `config.mjs`, which runs `loadLocalEnv()` at *module scope* and
reads `rocky.config.json` from disk at import time. So merely importing the CLI
boots Rocky's env loader and phone allowlists. `runtime.mjs` additionally drags in
`tenant-gateway` (627) + `docker-gateway` (206) + `openclaw-singleton` (165) — the
entire Docker orchestration layer.

**And there is a cycle at the package boundary:** `agent.mjs:15` imports
`runTenantAction` *from* the CLI, while the CLI imports back into the app. The CLI
is simultaneously a dependency and a dependent. `commander` is not installed;
`args.mjs` is 31 hand-rolled lines, which is why `user.mjs:471-479` spends 9 lines
re-validating flags and `index.mjs:72-74` rejects `--actor` at runtime instead of
in a schema.

**`user.mjs` is 492 of 495 lines of one-time migration — 0 lines of ongoing
product.** It is 58% of the whole `tenant-cli` directory, and the sole reason the
CLI imports `../phone.mjs` and `../paths.mjs`. Moving it to `scripts/migrations/`
deletes 2 of the 8 coupling points for free.

**Org packs:** `org/` exists, is empty, and is referenced only by `paths.mjs:10`
(definition) and `docker-gateway.mjs:113,152` (mkdir + mount). Nothing populates
it; no `skills.load.extraDirs` points at it. The mount is decorative — yet fully
contract-tested, so a contributor clones the repo, gets a green suite, and has no
signal that an org pack is meant to exist. `ROCKY_ORG_DIR` and `ROCKY_TENANTS_DIR`
— the two knobs that relocate all state — are absent from `.env.example`.

**Org identity is written three times and the last writer wins.**
`provision.mjs:65` copies `templates/workspace/` (including `IDENTITY.md` and
`USER.md`), then `:70-92` immediately overwrites both with inline strings. Editing
the checked-in template has no effect.

---

## 6. What would change this verdict

- Google routed through `tenant account login` with authorization + audit +
  `0600` + on-disk pending → closes §4 entirely.
- `index.mjs:243-271` routed through `runTenantAction` → removes the second auth
  implementation.
- Token handed to OpenClaw's credential store instead of a bind-mounted file →
  closes §2 and drops a mount.
- The Google REST branch in `agent.mjs:89` deleted → closes the gate bypass and
  the MCP bypass together. **Note this requires deleting `mcp-config.test.mjs:42-43`,**
  which currently asserts `enabled: false` — the suite is protecting the bypass.
- `org/` populated and wired into `skills.load.extraDirs`.

---

## 7. Recommended order

1. **Google parity with Claude** — mode, pending store, CLI route, audit. Smallest
   change, largest risk reduction, and the live `0644` refresh token makes it urgent.
2. **Close the two credential-minting bypasses** — `index.mjs:243-271` and
   `cli-home.mjs:102`.
3. **Delete the Google REST branch**, and the tests pinning it. This is the single
   edit that unblocks MCP-first, closes the auth-gate bypass, and lets
   `connect.mjs` and `google/tools.mjs` be deleted.
4. **Move the credential handoff to OpenClaw's store**; verify under Gate B.
5. **Split `index.mjs` and `tenant-openclaw.mjs`**; move `user.mjs`'s migration
   half to `scripts/migrations/`.
6. **Extract the CLI** to its own package on commander, inverting the outward
   imports.
7. **Populate `org/`** and wire `skills.load.extraDirs`.
8. **Rename ROCKY → ROCKY last** — most files carrying the 166 references are ones
   steps 3 and 5 delete.

Encryption at rest, Twilio, and Codex are deliberately excluded from this order:
the first two are separate workstreams, and Codex is deferred by instruction.

---

## 8. Operational items worth acting on immediately

- **27 live tenant directories sit in the working tree** with real-looking
  `cli-home/claude/.credentials.json`, `vault/llm-auth.json` and
  `vault/google-oauth.json`. `.gitignore:15` excludes `tenants/`, so they are
  untracked — but any packaging step that does not honour `.gitignore` ships
  them. At least one still carries the legacy `credentials.json` duplicate,
  which the code only removes on that tenant's next login. Sweep rather than
  wait for organic logins.
- **Host and container disagree on gateway bind mode, silently.**
  `tenant-openclaw.mjs:111` writes `bind: 'loopback'`;
  `entrypoint.sh:55` rewrites it to `'lan'` at container start. Both are right
  for their context, but the reconciliation lives in an unreviewable 15-line
  Node program embedded in a shell string.
- **`account`, `vault` and `mcp` are advertised CLI resources that only throw.**
  One third of the resource surface is a hardcoded array producing errors, and a
  test asserts the rejection.
- **`connect.mjs:27` and `:28` are byte-identical returns** — the guard on `:27`
  does nothing. A symptom of the missing registry: nobody can see the branches
  match because the list is retyped each time.
