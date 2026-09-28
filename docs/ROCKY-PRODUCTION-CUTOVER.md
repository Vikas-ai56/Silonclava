# Rocky production cutover

The repository is Rocky-first. This runbook migrates the live names separately.
Do not deploy the renamed runtime before completing these steps.

## Preconditions

- Schedule a maintenance window and stop new intake.
- Keep the old checkout, image, systemd unit and Postgres volume for rollback.
- Back up `/home/ubuntu/rift`, every tenant workspace, and the connector database.
- Record the 16 configured `RIFT_*` names without printing their values.

```bash
cd /home/ubuntu/rift
grep -E '^RIFT_[A-Z0-9_]+=' .env.local | cut -d= -f1 | sort
cp -p .env.local ../rift.env.local.before-rocky
docker compose exec -T connector-postgres \
  pg_dump -U rift_connector -d rift_connector -Fc > ../rift-connector.before-rocky.dump
```

## 1. Switch environment names

Rename only the `RIFT_` prefix; preserve every value. The migration release
prefers `ROCKY_*`, falls back to `RIFT_*`, and logs every fallback.

```bash
perl -pi -e 's/^RIFT_/ROCKY_/' .env.local
grep -E '^RIFT_[A-Z0-9_]+=' .env.local
```

The final command must return no lines. Also update variables supplied by the
shell, service manager, or deployment platform.

## 2. Drain and stop the old runtime

```bash
sudo systemctl stop rift-gateway.service
docker ps -a --format '{{.Names}}' | grep '^rift-oc-'
docker ps -a --format '{{.Names}}' | grep '^rift-oc-' | xargs -r docker stop
docker ps -a --format '{{.Names}}' | grep '^rift-oc-' | xargs -r docker rm
```

Tenant state remains in host bind mounts. Do not delete the old image.

## 3. Migrate workspace markers

Back up the workspace tree first. Change marker tokens only; do not replace
persona or guardrail content.

```bash
cp -a tenants ../tenants.before-rocky-markers
find tenants -type f -path '*/workspace/AGENTS.md' \
  -exec perl -pi -e 's/RIFT-GUARDRAILS/ROCKY-GUARDRAILS/g' {} +
find tenants -type f -path '*/workspace/SOUL.md' \
  -exec perl -pi -e 's/RIFT-PERSONA/ROCKY-PERSONA/g' {} +
grep -RniE 'RIFT-(GUARDRAILS|PERSONA)' tenants || true
```

The last command must return no live markers. The migration release still
reads the old tags so a hibernated tenant or restored backup cannot acquire a
second block.

## 4. Migrate connector database identity

Run the rename immediately before stopping the old Compose project. Keep its
volume intact for rollback.

```bash
docker compose exec -T connector-postgres psql -U rift_connector -d postgres \
  -c 'ALTER DATABASE rift_connector RENAME TO rocky_connector' \
  -c 'ALTER ROLE rift_connector RENAME TO rocky_connector'
docker compose -p rift down
docker volume create rocky_connector-postgres-data
docker run --rm \
  -v rift_connector-postgres-data:/source:ro \
  -v rocky_connector-postgres-data:/target \
  alpine:3.20 sh -c 'cp -a /source/. /target/'
```

Confirm the actual old Compose project and volume names before running these
commands; do not infer them if the deployment used `COMPOSE_PROJECT_NAME`.

## 5. Move the deployment and install Rocky services

```bash
cd /home/ubuntu
mv rift rocky
cd rocky
npm run docker:build:openclaw
npm run docker:connector:up
sudo cp deploy/rocky-gateway.service /etc/systemd/system/rocky-gateway.service
sudo systemctl daemon-reload
sudo systemctl disable rift-gateway.service
sudo systemctl enable --now rocky-gateway.service
```

The new gateway recreates `rocky-oc-*` containers from the existing tenant
mounts. The systemd unit writes `/home/ubuntu/rocky/logs/rocky.log`.

## 6. Verify before cleanup

```bash
curl -fsS http://127.0.0.1:8787/health
sudo journalctl -u rocky-gateway.service --since '10 minutes ago' \
  | grep -E 'RIFT_[A-Z0-9_]+ is deprecated' || true
docker ps -a --format '{{.Names}}' | grep '^rift-oc-' || true
docker ps -a --format '{{.Names}}' | grep '^rocky-oc-'
```

Exercise one tenant turn, one MCP call, one cron wake, media delivery, restart,
and connector-sidecar recreation. Verify existing Claude context is retained.
Only after the deprecation check stays empty should a separate commit remove
the environment fallback. Remove legacy marker matching only after live,
hibernated, restored and backup workspaces have been verified.

## Stable legacy formats

Do not rename `_riftVault`, `rift-vault:v1`, or the `rift-<phone>` OpenClaw
session key. They are persisted wire identities, not product branding.

## Rollback

Stop `rocky-gateway.service`, stop the Rocky Compose project, restore the old
directory or checkout, re-enable `rift-gateway.service`, and start the old
Compose project against its untouched volume. Restore the database dump only
if the original volume is unavailable.
