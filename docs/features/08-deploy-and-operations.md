# 08 — Deploy and operations

## Deploy order when the container contract changes

`deploy/push.sh` only rsyncs. It does not restart the gateway and it does not
rebuild the tenant image — which makes the order load-bearing whenever
`src/openclaw/container-paths.mjs`, `Dockerfile.openclaw` or
`docker/openclaw/entrypoint.sh` change.

`assertImageContract()` refuses to create a container from an image whose
`dev.rocky.contract.*` labels disagree with the host, and
`containerMatchesCurrentSpec()` removes any container whose mount destinations no
longer match. Restart the gateway on new code with an old image and every tenant's
container is destroyed and then cannot be recreated — a total outage, immediately,
for everyone.

```
1. deploy/push.sh aws-server                 rsync only; the old gateway keeps serving
2. ssh … docker build -t <new tag> -f Dockerfile.openclaw .
3. pin ROCKY_OPENCLAW_IMAGE=<new tag> in the host .env
4. sudo systemctl restart rocky-gateway      new code and new image together
5. send one real message and confirm a reply
```

Build under a **new tag** rather than rebuilding the pinned one in place: the old
image stays on disk, so rollback is `ROCKY_OPENCLAW_IMAGE` back plus a restart.
Rebuilding the same tag leaves the previous image dangling and unrollbackable.

## Topology

```text
public DNS  ──▶  Caddy (TLS)  ──▶  Rocky gateway (systemd, loopback)
                   │                  │
                   │                  ├─ docker: one container per tenant
                   │                  └─ cron-ingress listener on the docker bridge
                   │
                   └─ route set, in order:
                        /webhooks/*      → Rocky   (Twilio signature-checked)
                        /connect/*       → Rocky   NO basic auth  (OAuth callback)
                        /files/*         → Rocky   NO basic auth  (Twilio fetches media)
                        everything else  → basic auth
```

Two routes must stay outside basic auth, for the same reason: the caller is not
a browser with our credentials. The OAuth callback is the user's browser mid
flow; `/files/*` is `TwilioProxy/1.1` fetching media. Both were found as
production 401s, not in review.

Service unit: `deploy/rocky-gateway.service` (Node 22, `Restart=on-failure`,
`TimeoutStopSec=40` — longer than the shutdown grace period, or draining never
runs; P7). It is installed with `scp`, not a heredoc: nested quoting mangles the
file. `nohup` was tried first and died with the SSH session.

## Deploying

```bash
deploy/push.sh [ssh-host] [remote-dir]      # defaults: aws-server, /home/ubuntu/rocky
ssh <host> 'sudo systemctl restart rocky-gateway'
```

`deploy/rsync-exclude.txt` is the important half. `platform/` bites hardest: it
holds vault records encrypted with **that environment's**
`ROCKY_VAULT_MASTER_KEY`. Overwriting prod's with a laptop's yields "Vault key
mismatch" on every credential read, and a deploy is the last place anyone looks.
Also excluded: `tenants/`, `.env.local`, `.env`, `ops/`, `logs/`,
`baileys_auth/`. A test pins the exclude list.

## Environment-agnostic by rule

Product code never assumes localhost, Caddy or a public DNS name. The public URL
is configuration; the Twilio signature is validated against the **configured**
URL, never one reconstructed from request headers. Test seams are forbidden in
the production profile — `config.mjs` refuses to start if one is set.

Host-specific values are derived, not hardcoded: the container uid comes from
the image, the host uid from the process, the media signing key is generated per
host.

## Per-host settings worth knowing

| Variable | Default | Notes |
|---|---|---|
| `ROCKY_ALLOW_FROM` | open | Deliberately open: anyone may message the agent. |
| `MAX_TENANTS_PER_HOST` | 5 | Live containers. |
| `OPENCLAW_GATEWAY_IDLE_MS` | — | Hibernation idle window. |
| `OPENCLAW_LOG_MAX_BYTES` | — | Per-tenant log cap. |
| `ROCKY_MEDIA_SIGNING_KEY` | generated per host | Outbound media links. |
| `ROCKY_MEDIA_TTL_MS` | 1 h | Link lifetime. |
| `ROCKY_INBOUND_MEDIA_MAX_BYTES` | 16 MB | Inbound fetch cap. |
| `ROCKY_TRANSCRIBE_COMMAND` / `_TIMEOUT_MS` | `rocky-transcribe {{MediaPath}}` / 120 s | Voice notes. |
| `ROCKY_CONTEXT_MAX_MESSAGES` / `_CHARS` | 20 / 6 000 | Transcript replay bound. |

## Backups

`src/state-backup/backup.mjs` — `db.backup()` on the writer's own connection,
then verified by reopening the copy. Whole-tenant backup carries a hashed
manifest and is read back before it is called done. Restore goes **into staging
only**. `openclaw/` is deliberately excluded and recorded as excluded.

Operator surface: `tenant state status|backup|restore` (metadata only — never
message content, never credentials) and `tenant turn list` for failed or
ambiguous deliveries.

## Tests and gates

`npm test` — 79 test files, ~384 tests, run against **real containers**, not
mocks. Build-failing invariants worth knowing about:

- no `.prepare()` outside `src/tenant-data/`
- no undefined identifiers in `src/` (`test/no-undefined-identifiers.test.mjs` —
  written after three missing imports reached production, one of them hidden by
  a swallowing `try/catch`)
- no mount outside the tenant's own subtree
- no test seam in the production profile
- the rsync exclude list

Manual gates not covered by `npm test` are listed in `test/GATES.md`.

## Production incidents to remember

| What happened | Root cause | Fix |
|---|---|---|
| Whole fleet refused to start (2026-09-18) | `cron.skipMissedJobs` — an unknown key in a strict OpenClaw config schema | Rocky holds its own settings; never add speculative keys to `openclaw.json` |
| Vault key mismatch after a deploy | rsync carried `platform/` | `rsync-exclude.txt`, pinned by a test |
| OAuth callback → browser password prompt | `/connect/*` behind basic auth | route excluded |
| Media fetch 401 from Twilio | `/files/*` behind basic auth | route excluded |
| Typing indicator silently skipped | `external_message_id` missing from the inbound SELECT | column added to the projection |
| `OPENCLAW_GATEWAY_IDLE_MS is not defined` reached a user | missing import | undefined-identifier test |
