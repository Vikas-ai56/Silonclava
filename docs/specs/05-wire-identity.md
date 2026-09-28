# 05 — The three `rift` → `rocky` wire-identity migrations

**Status:** SPEC, not built. **Each sub-slice contradicts an existing logged decision.**

`DECISIONS.md:1236-1239` and `:1243-1266` record a deliberate choice to keep all three,
on the grounds that a persisted identifier is a wire format, not branding. The user has
since directed that everything be consistent before handover. These specs therefore
**supersede** those entries rather than editing them — but each carries a real cost,
stated honestly below.

`ROCKY-PRODUCTION-CUTOVER.md:117-119`, `TODO.md:19`, `TODO.md:47-49` also say "do not
rename". All must be superseded in the same PR.

---

## 05a — AEAD envelope v1 → v2

### Scope correction

This is **not** three vault records. `src/tenant-data/store.mjs:23` defines
`TRANSCRIPT_RECORD = 'transcript'` and uses the **same primitive** (`:11` imports
`encryptValue`/`decryptValue` straight from `src/privacy/aead.mjs`) for every message
body. The AAD for every row is `rift-vault:v1:<tenantId>:transcript`.

Two encrypted columns, in every tenant database:
- `messages.body_cipher` — `migrations.mjs:58`
- `context_checkpoints.summary_cipher` — `migrations.mjs:129`

So the migration is a **row-by-row re-encrypt of every message in every tenant**, plus
the vault JSON files. `features/02-tenant-isolation.md:65-66` documents only the vault
use of the primitive and never mentions the transcript — which is why this was
originally scoped as "3 records". Fix that doc.

### The delicate edit

`ENVELOPE_VERSION = 1` (`aead.mjs:15`) is used in **three coupled places**: the AAD
string (`:54`), the `isEncryptedEnvelope` equality check (`:65`), and the write (`:85`).
A v2 that must read v1 cannot keep `===` at `:65`, and the AAD must be derived from the
envelope's own discriminator, not from the module constant:

```js
const version = envelope._rockyVault ?? envelope._riftVault;
const prefix = envelope._rockyVault ? 'rocky-vault' : 'rift-vault';
```

Decoupling `:54` from `:65` is the single riskiest line in this suite. Write the
round-trip test first: encrypt v1, read as v2-capable, re-encrypt, decrypt.

### No existing machinery

`resources/vault.mjs:21-23` — `rotate` **throws unconditionally**. It implements
nothing; it is a naming seam only. The closest working analogue is
`rebindTenantVaultRecords` (`storage/vault-store.mjs:125-161`), which already does
decrypt-under-source → re-encrypt-under-target with raw-byte backups and rollback on
throw (`:156-171`). Model `migrateVaultEnvelopes()` on it. **No equivalent exists for
the SQLite columns — that must be written from scratch**, in a transaction, with the
master key present (`store.mjs:77` already asserts it).

Record names are **not an enum**: `vault-store.mjs:12-16` validates a charset and
`listVaultRecords()` `:95-106` enumerates whatever exists. Iterate the directory —
a hardcoded list would silently leave an unknown record at v1. Known names today:
`llm-auth`, `composio-mcp`, `composio-platform` (platform scope), `transcript` (SQLite),
and `google-oauth` which appears only in `test/tenant-uid.test.mjs:282-294`.

### Plan

1. v2 reader/writer in `aead.mjs`, decoupling `:54` from `:65`. Tests first.
2. `vault migrate` action replacing the dead `rotate` throw.
3. SQLite re-encrypt, per tenant, transactional, with a file-level backup first.
4. Verify with `verifyVaultRecords()` plus a full-transcript decrypt pass.
5. Drop v1 read support only once every tenant reports clean.

**Do not skip step 3's backup.** A failure mid-migration with v1 support already removed
is unrecoverable ciphertext.

### Tests to update
`test/mcp-config.test.mjs:93,202`; `test/llm-auth.test.mjs:42`;
`test/tenant-uid.test.mjs:229,297`; `test/context-assembly.test.mjs:161` — a hardcoded
full envelope literal inserted into `body_cipher`, which is itself the proof that
transcript and vault share the envelope. Needs a v2 twin.

---

## 05b — OpenClaw session key `rift-` → `rocky-`

### Blast radius: one system

Verified: the string is **write-only into OpenClaw**. It is never stored in our SQLite,
never written to `tenant.json` (only `sessionEpoch`/`sessionFromSequence` are), and
never logged. Sites:

- `src/tenant-session.mjs:7` — `const base = \`rift-${to || 'default'}\``
- `src/openclaw/tenant-openclaw.mjs:627` — the fallback `user: sessionUser || \`rift-${to || 'default'}\``

**Both must move together.** `:627` duplicates the prefix independently; renaming only
`tenant-session.mjs:7` would produce two different sessions for one tenant depending on
call path. `test/workspace-guardrails.test.mjs:134` asserts the *shape*
(`/user: sessionUser \|\|/`) but not the literal, so it would not catch this.

### There is no migration — only a cutover (P8)

OpenClaw derives its session id from the `user` field we send. A new prefix is a new
session. The old row stays on disk, unreferenced, and never expires (`session.reset` is
idle at 90 days). We must not rewrite `sessions.json` — and the production code already
never touches it; the only references are in tests.

**Effect:** every live tenant's conversation restarts once. Our SQLite transcript is
untouched, and `contextNeeded()` will see a cold session and replay a bounded window
(20 messages / 6000 chars) — so it degrades to a visible restart-with-context, not
amnesia. `sessionEpoch` is *not* bumped by a prefix change, so there is no epoch signal
that this happened; that is the argument for doing it as an explicit operator step.

This is open decision **D3**. With two live tenants the cost is small and it will only
grow.

### Also note
`quarantineForeignPathState` (`docker-gateway.mjs:424`) does not parse session keys — a
rename is invisible to it. But it renames the **entire** `agents/` tree on a hit, so if
it fires during the cutover it destroys both old and new sessions. Confirm it is not
armed before cutting over.

---

## 05c — Postgres / compose identity

### Recommendation: do not do this one

`DECISIONS.md:1243-1266` is an explicit, reasoned, recently-validated decision against
it, and `:1258-1260` records that this exact rename **already caused a production
incident**: "the renamed compose file declared `rocky_connector` while the live database
was `rift_connector`, so recreating the connector would have pointed it at a database
that does not exist."

Nothing a user can see changes. It is the only one of the three with an irreversible
data-loss mode: changing `COMPOSE_PROJECT_NAME` or the volume key yields a *different*
volume, Postgres initialises empty, and **every tenant's Composio connection state is
gone** — that state lives in the connector database, not in our SQLite.

Additional hazards: `rift_connector` is the only superuser on the instance, so
`ALTER ROLE … RENAME` needs a temporary superuser the runbook
(`ROCKY-PRODUCTION-CUTOVER.md:69-71`) does not create; and if the stored verifier is md5
rather than scram, the password breaks on rename because md5 hashes the username.

This is open decision **D4**. My recommendation is to leave the database identity and
accept it as a documented wire format, as the existing decision already concluded.

### Fix now regardless — a live bug in the same file

`docker-compose.yml:24` healthchecks `pg_isready -U rocky_connector -d rocky_connector`
while `:18-19` set `POSTGRES_DB`/`POSTGRES_USER` to `rift_connector`. Against a fresh
volume the healthcheck can never pass, and `composio-connector` has
`condition: service_healthy` (`:33-35`) — so it would never start. **This is the same
class of defect the previous incident was.** Land it as a standalone one-line change,
not as part of any rename.

Related asymmetry to leave alone: the Python package is already `rocky_connector`
throughout; only the database/role/volume/project identity is still `rift_*`. The
default in `services/composio-connector/src/rocky_connector/config.py:30` is
`rocky_connector`, which is dead under compose (overridden at `docker-compose.yml:41`)
but live for anyone running the service bare — a trap worth a doc line.

---

## Docs to supersede in the same PR

`DECISIONS.md:1236-1239`, `:1243-1266`; `ROCKY-PRODUCTION-CUTOVER.md:117-119`;
`TODO.md:19`, `:47-49`; `features/09-workspace-and-session.md:78-87`;
`features/02-tenant-isolation.md:65-66` (add the transcript's use of the envelope);
`features/03-persistence-and-context.md` (same); `CODEBASE.md:19`, `:68`.
