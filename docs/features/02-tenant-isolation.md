# 02 — Tenant isolation

One WhatsApp user = one tenant = one container = one encrypted store. The
boundary is enforced by what is mounted, not by what the code intends.

## What a tenant owns

```text
tenants/<tenantId>/
  tenant.json          identity, plan, phone claim
  workspace/           ← mounted rw   the agent's working directory
    inbox/             ← inbound media lands here                  [06]
  openclaw/            ← mounted rw   OpenClaw state, logs, cron db
    .home/             ← HOME inside the container
  cli-home/claude/     ← mounted rw   this tenant's Claude credentials + skills
  data/tenant.sqlite   ✗ NEVER mounted  transcript, turns, delivery  [03]
  vault/               ✗ NEVER mounted  AEAD-encrypted secrets
  audit.jsonl          ✗ NEVER mounted  redacted command audit

org/                   ← mounted ro   shared persona, skills, templates
platform/              ✗ host-only, git-ignored: platform vault, Composio runtime secrets
```

The mount list is built in one place — `src/openclaw/docker-gateway.mjs:283` —
and the container path constants live in `src/openclaw/container-paths.mjs`.
There is exactly one place to audit.

**Never mounted into a model container:** a vault (any tenant's), another
tenant's directory, or the tenant root itself. A test fails the build on a mount
outside the tenant's own subtree.

## Container hardening

| Flag | Why |
|---|---|
| `--cap-drop ALL` | Nothing in the image needs a capability. |
| `--security-opt no-new-privileges` | A setuid binary cannot escalate mid-run. |
| `--pids-limit`, `--memory` | One tenant cannot starve the host. |
| non-root image user | Combined with the above, a container breakout has nothing to land on. |
| loopback-only port publish | The gateway port is not reachable off-host. |
| `/run/rocky` tmpfs, `mode=1777` | The rewritten runtime config never touches disk. Mode is pinned explicitly because Docker's default differs between `create` and `restart`. |

`hostUidArgs()` forces `--user <uid>:<gid>` **on Linux only**. macOS Docker
Desktop maps uids itself and forcing one breaks the image — this is the one
platform difference in the runtime path and it is centralised in one function.

## Bring-up is ordered and mandatory

`src/openclaw/tenant-onboarding.mjs` runs the same named steps every time, in
order, stopping at the first required failure. Two phases:

- `PHASE.CREATE` — first container for this tenant.
- `PHASE.WAKE` — a hibernated tenant coming back. Configuration is **not**
  re-derived; an existing tenant wakes with the configuration it had.

Steps: tenant directory exists → agent credential (minted once, reused on wake)
→ container can read the mounts → bind-mount sources still exist (WAKE only).

`containerMountsIntact()` refuses to start a stopped container whose bind source
has vanished; the container is recreated instead of starting with an empty
directory that looks like data loss.

## Secrets

- Tenant secrets: AEAD (AES-GCM) via the single primitive in
  `src/privacy/aead.mjs`, under `tenants/<id>/vault/`.
- **The transcript uses the same primitive**, under record name `transcript` — every
  `messages.body_cipher` and `context_checkpoints.summary_cipher` row. A change to the
  envelope is a migration over every tenant database, not just the vault files.
- Platform secrets: `platform/vault/`, host-only, git-ignored, never deployed
  (`deploy/rsync-exclude.txt` excludes `platform/`, `tenants/`, `.env.local`).
- Secret input to the CLI is **stdin only** — never argv, stdout or audit.
- `src/privacy/policy-guard.mjs` blocks keys, tokens, OAuth codes, cookies,
  passwords, OTPs and card secrets *before* they can be persisted to the
  transcript. Findings never carry the matched text.

## How it fails

- **Missing mount source** → recreate, not start (above).
- **uid mismatch on Linux** → EACCES on first write; `ensureMountAccess()`
  chgrp/chmods the three writable mounts to the image's runtime group.
- **Host saturation** → `MAX_TENANTS_PER_HOST` (default **5**) bounds live
  containers; cron containers yield to interactive traffic.
