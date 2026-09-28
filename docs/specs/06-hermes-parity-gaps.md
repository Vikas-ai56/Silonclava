# 06 — Hermes parity gaps only

**Status:** SPEC. Audit date: 2026-09-25. No runtime work in this document is
implemented by writing the document.

This spec compares the locally mirrored production `.hermes` tree with the
current Rocky/OpenClaw repository. It records only capabilities or data that are
not already covered. The comparison used Graphify call/dependency graphs, the
Hermes SQLite stores and cron registry, and current official OpenClaw and
Composio documentation.

## 1. Boundaries

Do not rebuild these already-present foundations:

- Twilio webhook validation, inbound dedupe, persist-before-send delivery,
  status callbacks, retries and per-tenant turn serialization.
- One tenant container, workspace, OpenClaw state, Claude home, vault and
  encrypted transcript per tenant; hibernation does not remove those mounts.
- The Composio session/MCP bridge for the existing organization toolkits:
  Gmail, Google Calendar, Google Drive, Asana, Linear and Fireflies.
- Claude CLI subscription authentication, tenant identity resolution, media
  download/storage, signed outbound media URLs and document toolchain.
- Supermemory. It is intentionally not part of the target.

Native OpenClaw cron, memory and approval behavior is not load-bearing. Rocky's
host control plane owns reliability and authorization. Public OpenClaw docs are
current while the image is pinned to `2026.7.1-2`; a documented native feature
must be verified against that image before it is used.

## 2. Verified gaps

| Capability/data | Hermes evidence | Rocky evidence | Verdict |
|---|---|---|---|
| WhatsApp voice-note STT | `config.yaml` enables local STT; `gateway/run.py`, `hermes-agent/tools/transcription_tools.py`, `hermes-agent/plugins/br-tenant/services/stt.py` | `src/transcription.mjs` always returns `null` | **Missing by current decision:** wire the selected cloud STT provider |
| Outbound TTS/voice digest | `hermes-agent/plugins/br-tenant/services/deepgram_tts.py`, `services/voice.py`, `jobs/voice_digest.py` | Can send audio files but cannot synthesize them | Missing; optional unless the digest remains a product requirement |
| Cron execution plumbing | Six entries in `cron/jobs.json`; two enabled | Wake scheduler, ingress and mirror exist | Partial: no supported job creation/control path or migrated business jobs |
| Local tasks/records | `rocky.db`: 92 todos, 21 reminders, 14 notes, 10 expenses, 5 contacts | No equivalent tenant resource/store | Missing; data disposition is required before cutover |
| Email/calendar intelligence | `rocky.db`: 5 watchers and 1,590 briefs; `plugins/br-tenant/jobs/email_poll.py`, `scripts/br_tenant_daily_digest.py`, `meeting-intelligence` | Connectors expose APIs only | Missing business workflow, state and schedules |
| Durable approvals | `confirm_gate.py`; `rocky.db`: 143 pending actions | Prompt guidance and an `awaiting_approval` state, but no complete creation/resume gate | Missing; Phase 5 is a prerequisite for write-side automation |
| Bland calling | `tools/bland.py`, `utils/bland_client.py`; 62 Bland calls and 13 voice-call records | No call lifecycle | Missing |
| Outlook | One active Microsoft linked account | Not in `org/mcp/registry.json` | Missing toolkit/config and tenant re-authorization |
| Google Tasks | Todos can carry `google_task_id` | Not in the organization registry | Missing toolkit/config; not a migration for notes or expenses |
| Zoho CRM | `config.yaml`, `workspace/zoho-crm-mcp-server.py`, `skills/integrations/zoho-crm/` | No Zoho toolkit or server | Missing; custom VCC-module coverage must be checked separately |
| Deterministic legal render | `plugins/br-tenant/tools/legal_doc.py`, `generate_docx.py` | NDA templates refer to `legal_doc.render`, but `src/agent-mcp.mjs` exposes no such tool | Broken contract: templates exist, renderer does not |
| Curated memory/history | `profiles/<uid>/memories/{USER,MEMORY}.md`; `state.db` has 9,456 sessions and 40,788 messages | Vikas tenant has a new transcript but no imported `MEMORY.md` | Missing migration; raw history must not be injected wholesale |
| Custom workflow skills | High-use Hermes skills include meeting intelligence, email heartbeat, reminders and Bland calling | Some are copied into one Claude home but still call Hermes-only tools/paths | Copied content is not functional parity |
| Usage/admin reporting | `rocky.db` has 17,250 `llm_calls`; Hermes admin/feedback code | Logs and audit exist, but no equivalent usage dashboard | Lower-priority operations gap |

The generic Hermes Kanban implementation is not a migration requirement: no
populated Kanban database was found. The populated BugleRock records in
`rocky.db` are the task-management data that matter.

## 3. Required slices

### 3.1 Voice-note transcription

Keep `src/transcription.mjs` as the provider seam and implement the later
decision in `docs/DECISIONS.md`: cloud STT, currently Sarvam, with no local
Whisper fallback unless that decision is changed.

Potential files:

- `src/transcription.mjs`, `src/config.mjs`, `src/router.mjs`
- `test/transcription.test.mjs`, `test/router.test.mjs`
- `docs/features/06-multimedia.md`

Requirements:

- Audio stays in the tenant inbox; only that tenant ID and file may be used.
- Provider secrets come from the platform vault/environment, never a tenant
  prompt or OpenClaw config.
- Timeout, size/type validation, retry classification and a clear
  `[voice note ... not transcribed]` fallback are mandatory.
- Do not persist provider URLs or provider response envelopes.
- Correct `docs/features/06-multimedia.md`: it currently describes
  `tenant-transcribe.mjs`, `rocky-transcribe`, ffmpeg and Whisper artifacts that
  are not in this repository and were superseded by the cloud-STT decision.

Gate: a real Twilio OGG/Opus fixture produces text, provider failure produces
the explicit fallback, and a two-tenant test proves paths cannot cross.

### 3.2 Structured user records and migration

Before importing, choose one destination per record class:

| Hermes record | Default target | Migration action |
|---|---|---|
| Todos | Google Tasks through the tenant's Composio identity | Import after user reconnects; preserve completion/due date and an origin ID |
| Reminders | Rocky-owned scheduled record | Import only after Phase 6 creation/execution is implemented |
| Notes | Decision required | Do not guess between workspace Markdown and an external notes service |
| Expenses | Decision required | Archive unless a governed finance destination is selected |
| Contacts | Existing address-book connector or archive | Do not create duplicates by name alone |

All migration mutations go through the resource-based tenant CLI. The model may
use approved agent actions, but it cannot invoke an unrestricted import,
restore, or cross-tenant selector. Imports need dry-run, stable source IDs,
idempotency and per-tenant count reconciliation.

Gate: totals reconcile for every selected tenant, rerunning imports creates no
duplicates, and records with no approved destination remain in a readable cold
archive.

### 3.3 Approvals before write automation

Complete the existing Phase 5 approval design before enabling email send,
calendar mutation, CRM mutation, calling, or recurring jobs that can take side
effects. This spec does not duplicate Phase 5.

Gate: the host enforces an approval over the exact payload hash and resumes the
same leased action. Prompt-only confirmation does not pass.

### 3.4 Cron and proactive intelligence

Keep the already-decided ownership model: Rocky owns a job record; a due job
enqueues a leased turn. Do not make OpenClaw's internal scheduler authoritative.

Port only live, useful behavior:

1. Daily memory refresh can be recreated after its memory write target exists.
2. Daily digest depends on watcher/brief state and email/calendar polling, so
   its schedule cannot be migrated before that workflow.
3. The four disabled Hermes jobs stay disabled and are not silently recreated.

The Phase 6 spec must add the tenant-CLI schedule lifecycle, chat creation via an
authorized agent action, lease/dedupe behavior, 24-hour WhatsApp-window handling
and one real end-to-end job test. Existing mirror/wake code is reused or removed
according to that spec; no second scheduler is added.

For email/calendar intelligence, port the business rules, not the old OAuth or
API wrappers. Gmail, Calendar and Outlook access comes from the tenant's
Composio MCP session. Watchers, briefing state and delivery history remain
tenant-owned Rocky data.

### 3.5 Connector additions

Official Composio pages currently confirm:

- Outlook: slug `OUTLOOK`, managed OAuth, mail and calendar tools.
- Google Tasks: slug `GOOGLETASKS`, managed OAuth.
- Zoho: a Zoho CRM toolkit exists, but exact parity with the custom VCC module
  must be proven before removing the custom server.
- Bland AI: slug `BLAND_AI`, API-key authentication, only 10 listed tools and
  no triggers. It does not by itself prove parity with placing calls, webhook
  status, recordings and the existing after-action-review flow.

Registry changes remain organization-owned and code-reviewed. Each user still
connects their own Outlook/Google/Zoho account under their tenant Composio user
ID. Existing Hermes refresh tokens are not copied; users reconnect through a
sign-in link. Multiple accounts per toolkit remain deferred by `BL-001`.

Potential file: `org/mcp/registry.json`, followed by the existing organization
build/validate/publish workflow. Remove the stale Outlook example from
`src/agent-mcp.mjs` until Outlook is actually registered.

For Zoho, rotate the old client secret at cutover because credentials are
present in the mirrored configuration/backups. Put replacement configuration
in the established platform/tenant vault boundary; never copy inline secrets.
If Composio lacks the custom VCC operations, specify one narrow organization
MCP sidecar as an explicit exception rather than pretending parity exists.

### 3.6 Bland and outbound voice

Treat calls as a side-effecting lifecycle, not a single MCP invocation:

`requested → approved → submitted → provider status events → final transcript /
recording metadata → delivered summary`.

Persist provider call IDs, normalized status events, idempotency keys and the
minimum audit metadata per tenant. Webhooks must tolerate duplicates and
out-of-order events. Recordings/transcripts follow the transcript retention and
privacy policy. Bland credentials are organization-owned if the same firm
account places every call; they still never enter a model prompt.

Gate: duplicate callbacks do not duplicate a call or user delivery; a denied
request makes no provider call; tenant A cannot read tenant B's call state.

### 3.7 Legal-document renderer

Restore a deterministic renderer for the organization NDA templates or remove
the `legal_doc.render` instruction. The renderer accepts a validated schema,
loads only versioned organization templates, writes only into the requesting
tenant workspace and returns a relative file path for the existing media-send
flow. It is exposed through the authorized Rocky agent surface; no direct host
filesystem path is model-selectable.

Gate: a fixture renders DOCX/PDF, invalid fields fail before writing, and a
tenant cannot select another tenant's template output.

### 3.8 Memory and historical data

For the Vikas pilot, import the curated Hermes `USER.md`, `MEMORY.md` and only
selected daily notes into the tenant workspace. Merge explicitly; do not
overwrite current identity/persona files. The 1.1 GB session tree and raw
`state.db` messages stay as a cold, access-controlled archive until retention
and subject-right decisions in `BL-002` are resolved.

Do not replay historical turns into Claude or the live transcript. Cross-history
search remains deferred by `BL-005`. New Rocky messages already retain durable
channel history independently of container lifetime.

Gate: Vikas can retrieve an imported durable fact after container recreation,
and no other tenant can retrieve it.

### 3.9 Skill disposition

Promote only universal BugleRock workflows to the organization bundle. Adapt
them to Composio MCP and the tenant CLI before publishing:

- meeting intelligence and email heartbeat depend on §3.4;
- reminders depend on Phase 6;
- Bland calling depends on §3.3 and §3.6;
- `br-tenant-direct-invocation` is Hermes-specific and is not ported;
- direct Google Workspace wrappers are replaced by Composio, not duplicated;
- personal Claude skills remain inside that tenant's Claude home.

Copied skill text that references `skill_view`, Hermes `cronjob`, direct OAuth
files, raw API-key environment variables or Hermes filesystem paths fails the
organization-bundle gate.

## 4. Data disposition summary

| Data | Action |
|---|---|
| Curated profile memory | Import per tenant |
| Todos/reminders/notes/expenses/contacts | Import only after destination decision; otherwise cold archive |
| Linked OAuth accounts | Re-authorize through per-tenant Composio links; do not copy tokens |
| Watchers/briefs | Import only with the proactive workflow that understands them |
| Enabled cron jobs | Recreate after dependencies; never copy provider-internal rows |
| Disabled cron jobs | Leave disabled; document only |
| Pending approvals | Do not resume blindly; operator reviews the one pending item, then archive |
| Bland/voice call history | Audit archive; never recreate calls |
| Raw sessions/messages | Cold archive, not prompt context |
| Audio cache | Archive or expire under retention policy |
| Generic upstream Hermes tools/skills | Do not migrate without product usage evidence |

## 5. Implementation order

1. Correct the multimedia documentation and add real cloud STT.
2. Import Vikas's curated memory and decide destinations for populated local
   records.
3. Complete Phase 5 approvals.
4. Add Outlook, Google Tasks and verified Zoho coverage through the existing
   Composio registry/session path.
5. Complete Phase 6 job creation, then port watchers, briefs and the daily
   digest.
6. Restore deterministic legal rendering.
7. Add Bland/outbound TTS only if those product behaviors remain required.
8. Add usage/admin reporting after cutover observability is stable.

Each slice updates `features/`, `DECISIONS.md` and `CODEBASE.md` in the same
change. No slice may create a second credential manager, OAuth path, MCP proxy,
tenant selector, delivery ledger or scheduler.

## 6. External evidence and version sensitivity

- OpenClaw: [cron jobs](https://docs.openclaw.ai/automation/cron-jobs),
  [heartbeat](https://docs.openclaw.ai/gateway/heartbeat),
  [audio](https://docs.openclaw.ai/nodes/audio), and
  [memory](https://docs.openclaw.ai/concepts/memory).
- Composio: [per-user authentication](https://docs.composio.dev/docs/authentication),
  [sessions over MCP](https://docs.composio.dev/docs/sessions-via-mcp),
  [Outlook](https://docs.composio.dev/toolkits/outlook),
  [Google Tasks](https://docs.composio.dev/toolkits/googletasks),
  [Zoho](https://docs.composio.dev/toolkits/zoho), and
  [Bland AI](https://docs.composio.dev/toolkits/bland_ai).

These pages establish availability, not behavior in the pinned OpenClaw image
or parity with BugleRock's custom workflows. Live contract tests remain the
acceptance authority.
