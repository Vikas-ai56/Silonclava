# Runbook — connector database `rift_connector` → `rocky_connector`

**Status:** rehearsed 2026-09-22 against a throwaway database; not yet executed
against the live stack. Approved 2026-09-22.

**Rehearsal result:** dump → restore into a `rocky_connector` database reproduced the
schema, indexes and sequence **identically** (column diff and index diff both empty,
`connector_audit_id_seq` restored to 29), row counts exact (9 / 29), and the live
sidecar image started against it, reported `{"ok":true,"service":"rocky-composio-connector"}`,
held a pooled connection and accepted a write with the sequence continuing at 30.
The live stack was never touched.
**Expected downtime:** connector only, ~5–10 minutes. The WhatsApp gateway keeps
serving turns; only Composio tool calls fail while the connector is down.
**Expected side effect:** possibly none. See "What is actually at stake" below.

`DECISIONS.md:1258-1260` records the previous attempt: the compose file was renamed
while the live database was not, so recreating the connector would have pointed it at
a database that does not exist. **The code change and the data change must land in the
same window.**

## What is actually at stake — measured 2026-09-22

The connector database holds exactly two tables:

| Table | Rows | What it is |
|---|---|---|
| `connector_idempotency` | 9 | Request de-duplication keys, with `expires_at`. Ephemeral by design. |
| `connector_audit` | 29 | Append-only audit trail of connector actions. |

**No tenant Composio connection state lives here.** Connections live in Composio's
cloud; the per-tenant tool-router endpoint lives in the tenant vault
(`composio-mcp` record, `tenants/<id>/vault/`), which this migration does not touch.
Losing this volume would cost 9 expiring keys and an audit trail — not a single
tenant's toolkit connection.

Verified: the role's password verifier is **scram**, not md5, so the md5 rename hazard
does not apply here. `rift_connector` is confirmed as the only superuser.

---

## What actually changes

| Thing | From | To |
|---|---|---|
| Database | `rift_connector` | `rocky_connector` |
| Role | `rift_connector` | `rocky_connector` |
| Compose project | `rift` | `rocky` |
| Volume | `rift_connector-postgres-data` | `rocky_connector-postgres-data` |
| Containers | `rift-connector-postgres-1`, `rift-composio-connector-1` | `rocky-…` |

Files: `docker-compose.yml:18,19,20,41`, `scripts/compose.mjs:17`,
`services/composio-connector/src/rocky_connector/config.py:30` (already `rocky_`,
dead under compose but live for a bare run), `test/composio-sidecar-docker-smoke.test.mjs`
(already asserts `rocky_connector` — it has been ahead of compose all along).

---

## Pre-flight

```bash
ssh aws-server
cd /home/ubuntu/rocky

docker ps --filter name=rift- --format '{{.Names}}\t{{.Status}}'
docker volume ls | grep connector

docker exec rift-connector-postgres-1 \
  psql -U rift_connector -d rift_connector -c "\dt"

docker exec rift-connector-postgres-1 \
  psql -U rift_connector -d rift_connector -tAc \
  "SELECT rolname, CASE WHEN rolpassword LIKE 'SCRAM%' THEN 'scram' ELSE 'md5-or-null' END
     FROM pg_authid WHERE rolname='rift_connector'"
```

**Re-run the last query before executing.** It reported `scram` on 2026-09-22, which
means an in-place role rename would not break the password. Dump/restore is still the
chosen path because `rift_connector` is the only superuser and a role cannot rename
itself — an in-place rename needs a temporary superuser created first.

**Take the dump regardless.** It is the rollback.

```bash
docker exec rift-connector-postgres-1 \
  pg_dump -U rift_connector -d rift_connector --no-owner --no-acl \
  > /home/ubuntu/rocky-connector-$(date +%Y%m%d-%H%M).sql
wc -l /home/ubuntu/rocky-connector-*.sql
```

---

## Execute

Dump-and-restore into a new volume. Chosen over `ALTER DATABASE … RENAME` because
`rift_connector` is the only superuser on the instance, so an in-place role rename
needs a temporary superuser that does not exist yet — and creating one is more moving
parts than restoring into a clean database.

> **The compose edits happen in the repo, not on the host.** `docker-compose.yml` and
> `scripts/compose.mjs` are **not** in `deploy/rsync-exclude.txt`, so `deploy/push.sh`
> overwrites whatever is on the host. Editing them with `sed` on prod works until the
> next deploy silently reverts them — compose back to `rift_connector` against a
> database that is now `rocky_connector`. That is `DECISIONS.md:1258-1260` in reverse.
> Edit locally, commit, then deploy inside this window.

```bash
# --- LOCAL, before anything on the host ---
sed -i '' 's/rift_connector/rocky_connector/g; s/rift-connector-local/rocky-connector-local/g' docker-compose.yml
sed -i '' "s/|| 'rift'/|| 'rocky'/" scripts/compose.mjs
grep -n "rocky_connector\|'rocky'" docker-compose.yml scripts/compose.mjs
npm test

# --- ON THE HOST ---
ssh aws-server
cd /home/ubuntu/rocky
DUMP=/home/ubuntu/rocky-connector-<stamp>.sql

# Stop the old stack by its real container names; the new compose file does not
# know them, so `compose down` after the deploy would leave them running.
docker stop rift-composio-connector-1 rift-connector-postgres-1
docker rm   rift-composio-connector-1 rift-connector-postgres-1

# --- LOCAL: deploy the renamed compose file ---
#   deploy/push.sh aws-server
# --- back ON THE HOST ---

# 2. Bring up Postgres alone and let it initialise the new database.
node scripts/compose.mjs up -d connector-postgres
until docker exec rocky-connector-postgres-1 pg_isready -U rocky_connector -d rocky_connector; do sleep 2; done

# 3. Restore.
docker exec -i rocky-connector-postgres-1 \
  psql -U rocky_connector -d rocky_connector < "$DUMP"

# 4. Verify BEFORE starting the sidecar.
docker exec rocky-connector-postgres-1 \
  psql -U rocky_connector -d rocky_connector -c "\dt"
docker exec rocky-connector-postgres-1 psql -U rocky_connector -d rocky_connector -tAc \
  "SELECT 'idempotency', count(*) FROM connector_idempotency
   UNION ALL SELECT 'audit', count(*) FROM connector_audit"

# 5. Sidecar and gateway together. They pair on the assertion issuer and reject
#    each other if only one moves.
node scripts/compose.mjs up -d --build composio-connector
sudo systemctl restart rocky-gateway
```

---

## Verify

```bash
curl -sS localhost:8787/api/status | python3 -m json.tool | head -30

./bin/tenant.mjs mcp doctor --tenant <id>
./bin/tenant.mjs mcp list --tenant <id>
```

Then a real WhatsApp turn that uses a Composio tool. Toolkit connections are expected
to **survive** — they live in Composio's cloud and in the tenant vault, not here. If
any come back disconnected, walk that tenant through `connect <toolkit>` in chat.

---

## Rollback

The old volume is untouched until step 7, which is why it is last.

Revert **locally** and redeploy — reverting only on the host is undone by the next
deploy, which is the same trap as above.

```bash
docker rm -f rocky-composio-connector-1 rocky-connector-postgres-1
# LOCAL: git checkout docker-compose.yml scripts/compose.mjs && deploy/push.sh aws-server
ssh aws-server 'cd /home/ubuntu/rocky && node scripts/compose.mjs up -d connector-postgres composio-connector'
ssh aws-server 'sudo systemctl restart rocky-gateway'
```

The old volume `rift_connector-postgres-data` is still intact at this point, so the
rollback restores the original data, not the dump.

---

## 7. Only after a clean day

```bash
docker volume rm rift_connector-postgres-data
```

Do not run this in the same window. It is the only step that cannot be undone, and
the dump is not a substitute for the volume if the restore was subtly wrong.

---

## Afterwards

- Supersede `DECISIONS.md:1243-1266` with the outcome.
- `ROCKY-PRODUCTION-CUTOVER.md:117-119` and `TODO.md:19` still say "do not rename".
- `services/composio-connector/src/rocky_connector/config.py:30` default is already
  `rocky_connector` and becomes correct rather than merely unused.
