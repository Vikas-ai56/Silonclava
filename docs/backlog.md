# Migration backlog

This file is the single register for migration work intentionally deferred from
an active specification. Active requirements remain in the relevant `SPEC-*`
document; deferred requirements belong here and must not be implemented as
unplanned extensions.

For each new item, record its status, reason for deferral, prerequisites, and
acceptance criteria. Moving an item back into scope requires updating the
relevant specification first.

---

## BL-001 — Multiple accounts per connector toolkit

**Status:** CLOSED 2026-09-25 — shipped. Composio's tool router already supported
several accounts per toolkit with an explicit `account` argument per execution;
the flags were never passed. See `docs/features/04-org-mcp-composio.md` and
`docs/DECISIONS.md`, 2026-09-25. The scope below is the record of why it was
deferred, not current behaviour.

**Current scope:** One active connected account per toolkit for each tenant.
Connecting another account is rejected until the existing account is explicitly
disconnected. This applies initially to Gmail/Google Workspace, Outlook, Asana,
and other Composio toolkits.

**Reason for deferral:** The first migration only needs one account per toolkit.
Deferring selection and aliasing keeps Phase 3 focused on tenant isolation,
native OpenClaw MCP projection, credential safety, and the Vikas cutover.

**Prerequisites:**

- The single-account Composio flow is stable in production.
- Composio exposes deterministic connected-account targeting through its native
  MCP session behavior.
- The tenant control plane remains the only authority allowed to change account
  selection.

**Acceptance criteria when resumed:**

- A tenant can connect multiple accounts for the same toolkit without creating
  multiple OpenClaw MCP server definitions.
- Connections have stable IDs and tenant-owned display aliases.
- The tenant can list, select, replace, and disconnect one account without
  affecting another.
- Tool execution targets the explicitly selected account; first-match behavior
  is forbidden.
- Account selection, audit output, vault handling, restart persistence, and
  two-tenant isolation have automated and live tests.

---

## BL-002 — Transcript retention, residency, and subject rights

**Status:** Deferred — scoping only, no implementation

**Current scope:** Phase 3C stores the canonical channel transcript encrypted
per tenant in `tenants/<uid>/data/tenant.sqlite`. Retention duration, deletion,
export, and legal-hold behaviour are deliberately unimplemented. The store is
written and read only by the host control plane; `data/` is never mounted into a
model container.

**Reason for deferral:** These are compliance decisions, not engineering ones.
They require an approved retention period and a residency position before code
is written. Implementing a guess would be worse than implementing nothing.

**Correction to a common assumption:** storing transcripts is very likely
*required*, not risky. A MAS CMS-licensed / SEBI-registered entity generally
must retain client communications for a defined period. Deleting them is the
more probable violation. The real obligations are what the store may contain,
how long it is kept, where it physically sits, and how an access or erasure
request is answered.

**Scale is not a constraint.** At roughly 16 users × ~40 messages/day × ~1 KB,
the entire firm generates ~230 MB/year. Ten years is ~2 GB. Any feasibility
concern here is misplaced.

**Prerequisites:**

- An approved retention period, expressed in years.
- A data-residency position (Singapore vs India) for the host holding
  `tenants/**`.
- A decision on how subject access and erasure interact with legal hold, since
  they conflict.
- Confirmation of which record classes are in regulatory scope.

**Acceptance criteria when resumed:**

- Retention is configurable per record class and enforced by an automatic job.
- Export and erasure exist as authorized, audited, operator-only actions.
- Legal hold suppresses erasure without suppressing retention.
- The persistence guard provably excludes credentials, authorization codes,
  payment data, system prompts, and raw tool payloads from stored bytes.
- Residency is verifiable from the deployment, not asserted in a document.

**Plug-and-play requirement (applies now, not when resumed):** so this work is
additive later rather than a rewrite, four things must be true from the first
implementation — a narrow `TranscriptStore` port with SQLite as one adapter; the
privacy guard as a separate module in front of that port; schema versioning from
the first row; and export/erasure present as unimplemented interface stubs so
the interface does not change when they are built.

---

## BL-004 — Hibernation and host-owned wake scheduling

**Status: PROMOTED TO CORE, 2026-09-18.** No longer deferred. This is now the
runtime shape of Phase 3C — see `DECISIONS.md` "Runtime shape" and `SPEC-phase3c`
§1.4. Retained here as the record of why it was deferred and what changed.

**What it achieves:** RAM cost tracks *active* users rather than *registered*
users. Always-on costs 213 MiB per tenant with no elasticity; on a fixed 4 GB VM
that caps the product at roughly ten users, whatever the tenant count grows to.
Hibernation makes capacity a function of *concurrency*, which is a small number,
instead of *registrations*, which is not.

It does **not** weaken isolation. Each tenant keeps its own OpenClaw instance,
container, credentials and state. Hibernation changes when an instance runs, not
whose it is.

### Why it was deferred, and what changed

| Original blocker | Resolution |
|---|---|
| *"OpenClaw reschedules overdue jobs rather than replaying them on restart"* | **The premise was false.** Measured against the pinned image: a missed job fires **once** on restart regardless of outage length, because eligibility compares only the most recent slot (`previousRunAtMs > lastRunAtMs`). `agentTurn` jobs are deferred 2 min, others capped at 5 with a 5 s stagger. Hibernation delays cron; it does not lose it. |
| *"Waking on a schedule would require reading OpenClaw's own SQLite, which violates P8"* | **Still valid, and designed around.** Rocky mirrors each tenant's schedule into its own database while the container is warm and schedules wakes from the mirror. OpenClaw's store is a refresh input, never the authority. |
| *"Wake-on-inbound latency ... measured against real cold-start time"* | **~4.4 s** to `[gateway] ready`, measured. Acceptable for a first message after idle. |
| *"A tenant count that justifies the complexity"* | 4 GB fixed, tenant count growing past the always-on ceiling. Justified. |

### Operating parameters

- **5 warm containers; cron may hold at most 3.** At least 2 slots stay
  available to interactive traffic, which is what keeps preemption rare rather
  than routine.
- **Idle means no explicit user request.** Job execution never resets the timer.
  This is load-bearing: without it, cron alone keeps every container resident and
  hibernation reclaims nothing.
- **Interactive preempts cron.** Never preempt a container with an interactive
  turn in flight (`inFlight`). A due cron wake at capacity is queued, not forced.
  A preempted cron job is not marked failed — it re-fires on next wake, so a
  failure record would be wrong and would raise false alerts.
- Victim order: fully idle first, then longest-since-*user*-interaction.

### Acceptance criteria

- Hibernation triggers only on user inactivity; job execution never resets it.
- Waking is automatic on the next inbound user message, with no manual step.
- A cron job due while its tenant is hibernated fires, woken by the host ahead of
  time, and is delivered through the same persist-then-send path as a user reply.
- Workspace, OpenClaw state, Claude CLI credentials, vault and transcript all
  survive a hibernate/wake cycle unchanged.
- Generation stamping survives the cycle, so a late reply from the
  pre-hibernation container is rejected.
- The wake scheduler reads Rocky's own mirror. A test proves wakes still schedule
  when OpenClaw's store is unreadable or its schema has changed.
- Under load, an inbound user message is served without waiting on a cron job,
  and no interactive turn is ever preempted mid-flight.

---

## BL-005 — Content search over the encrypted transcript

**Status:** Deferred — but the decision constrains the Phase 3C schema now

**Current scope:** message content is encrypted per tenant with AES-GCM at the
application layer; metadata (ids, timestamps, sequence) stays plaintext so it can
be indexed. No content search is offered.

**Why this cannot simply be added later.** Measured, not inferred: a
**contentless** FTS5 index (`content=''`, the documented "don't store the
original" mode) still writes every plaintext token into the raw database file.
Grepping the file bytes recovered company names and the word "confidential". The
inverted index holds plaintext terms with per-document positions. So FTS5 over
decrypted content **defeats the encryption**, and FTS5 over ciphertext is
meaningless. They are mutually exclusive, not merely degraded.

Silent failures worth knowing about in the current design: `LIKE '%term%'` over
encrypted rows returns **0 matches with no error** (SQLite coerces blob bytes to
a string); `ORDER BY content` sorts by random IV; `UNIQUE(content)` never fires
because two encryptions of identical plaintext differ; `COLLATE NOCASE` is a
no-op on blobs.

**Options when resumed:**

- **Move encryption below the SQL layer** — `better-sqlite3-multiple-ciphers`
  (MIT, version-locked to better-sqlite3 13.0.3, ships prebuilds, FTS5 enabled).
  FTS5, `LIKE`, `ORDER BY` and `UNIQUE` then work normally because page-level
  encryption sits under the b-tree. Pass a raw hex key to skip its
  256k-iteration KDF on every open. Cost: loses field-level separation — the
  ops/backup path holds a key that opens everything.
- **Truncated blind index** — HMAC of normalized tokens in a side table under a
  **separate** key, truncated to 32–64 bits so collisions blur the frequency
  histogram. Exact match only. Untruncated, the token-frequency histogram is
  fully exposed (verified).
- **Decrypt-in-memory scan** — more viable here than usual, because one file per
  tenant bounds the corpus and plaintext timestamp/sequence predicates narrow it.

**Never** index plaintext into FTS5 alongside encrypted content.

**Prerequisites:**

- A product decision on whether content search is required at all.
- The BL-002 retention and residency answers, which determine whether whole-file
  encryption is acceptable.

**Acceptance criteria when resumed:**

- Search returns correct results with no plaintext in raw file bytes, verified by
  grepping the database file rather than by reading code.
- The chosen approach is benchmarked on the Linux target, not taken from vendor
  figures.

## BL-006 — Shared Twilio sender number is a cross-tenant throughput bottleneck

**Status:** open but **downgraded 2026-09-18** — the operator reports a paid
Twilio account with throughput that comfortably covers current needs, and no
explicit testing is wanted. The bottleneck is real but not currently binding.
Revisit if cron fan-out grows or a send-rate error appears in
`delivery_attempts`.

Every tenant sends from the same `TWILIO_WHATSAPP_FROM`. WhatsApp Business
enforces throughput per sender number and per 24-hour tier, so one number is a
resource shared by every tenant on the box. Twilio queues and fans out sends
across users fine, but it cannot raise that ceiling.

The concrete trigger is cron: scheduled jobs cluster at human-friendly times, so
a 09:00 fan-out across N tenants produces N sends in one burst through a single
number. N grows with tenant count, and hibernation does not help here: a cron
wake brings the container up precisely so it can send.

**Why this is not handled by the per-tenant FIFO lane:** that lane guarantees
ordering *within* one conversation. It places no bound on aggregate send rate
*across* tenants, which is what the number's quota constrains.

**Not blocking Phase 3C**, because delivery-attempt records and bounded retry
(§6) already make a throttled send recoverable rather than lost.

**Acceptance criteria when resumed:**

- A measured send-rate ceiling for the production number and messaging tier,
  taken from Twilio's own account limits, not assumed.
- A global outbound rate limiter with per-tenant fairness, so one tenant's cron
  fan-out cannot consume the whole window.
- A gate that saturates the limiter and asserts no message is dropped and no
  conversation is reordered.
- A decision on whether per-tenant sender numbers are warranted at some tenant
  count, with the cost compared against the throttling work.

## BL-007 — Four Phase 3C gates that are not yet run

**Status:** CLOSED 2026-09-21. All four are now run against production:

| Gate | Evidence |
|---|---|
| A live model turn | Turns completing on Sonnet 5 through the container, 25s, logged |
| Hibernate → wake → cron | One session spanning 2026-09-20 13:44 → 2026-09-21 09:09 across several hibernation cycles and two container recreations |
| Twilio signature against real traffic | Every inbound message since the Twilio cutover; a forged signature returns 403 |
| Off-host backup transfer | `state backup` → 753 files, `verified: true`; transferred to a separate machine and re-verified there with `verifyTenantBackup` → `integrity: ok`, zero mismatches, manifest schemaVersion 5 |

The off-host copy was deleted after verification: it carries a tenant's
encrypted vault and transcript and had no reason to persist off the host.
Raised 2026-09-18 at the end of step 7.

Steps 0–7 are implemented and 270 automated tests pass, including live Docker
cold-recreate, isolation, privacy, crash-window and restore gates. These four
remain unrun because each needs something the test environment does not have.
They are listed in `test/GATES.md`; this entry records why and what unblocks
them.

### 1. A live model turn with a real Claude credential

Everything downstream of the model is tested with the model stubbed: the queue,
turn state machine, privacy guard, encryption, persist-before-send, delivery
ledger and status callbacks are all exercised. What is **not** exercised is
`runOpenclawTurn` against a real Claude CLI — terminal SSE completion, session
reuse, and the MCP bridge.

**Unblocked by:** a disposable tenant Claude credential.
**Risk if skipped:** the terminal-completion change (§2) is unverified against a
real token stream. It was made because delta-idle could commit a partial answer;
that fix is argued from the event shapes, not observed end to end.

### 2. Hibernate → wake → cron fires → delivered, end to end

The wake scheduler is tested through an injected harness, so wake and hibernate
are recorded rather than real. A full cycle — container hibernates, host wakes
it from its own mirror, OpenClaw fires the job, the result reaches the cron
ingress and is delivered — has never run as one flow.

**Unblocked by:** (1), since the job needs a real model turn.
**Risk if skipped:** the mirror refresh timing (§3a "Refresh discipline") is the
part that fails silently. A job created in-container and never mirrored is never
woken, and nothing errors.

### 3. Twilio signature validation against real webhook traffic

`computeSignature` matches Twilio's published worked example exactly, and the
adapter validates against the configured public URL rather than one rebuilt from
request headers. But no real signed webhook has ever hit this code.

**Unblocked by:** pointing `https://irock.buglerockadvisors.com/webhook/whatsapp`
at this service. That URL currently proxies to the Hermes gateway on
`localhost:9119`, so this is a cutover, not an addition.
**Risk if skipped:** a proxy that rewrites the path or body encoding would break
validation in a way only real traffic reveals.

### 4. Off-host encrypted backup transfer — DESCOPED 2026-09-18

**Operator decision: backups stay on the VM.** The 128 GB disk is ample —
measured growth is 1,688 bytes per turn, so 100 tenants for a year is roughly
3 GB of transcript. Off-host transfer and archive encryption are **not built**.

**Accepted risk, stated plainly:** losing the VM loses every tenant backup with
it. §8's "a same-VM archive alone is not disaster recovery" still holds; it is
simply accepted at this scale. Revisit before the tenant count or the
regulatory position changes.

Original scope follows.

§8 requires the archive to be encrypted, written to an off-host target, and
verified by reading it back, and states plainly that *"a same-VM archive alone is
not disaster recovery."* Implemented: verified local snapshots with a hashed
manifest, integrity check, and staged restore. **Not implemented:** encryption of
the archive and transfer off-host.

**Unblocked by:** choosing the off-host target (object store, second host) and
the archive encryption key's custody — which is a compliance decision, not a
coding one.
**Risk if skipped:** losing the VM loses every tenant backup with it.

**Acceptance criteria:** each gate run, with evidence (image digest, Claude CLI
version, disposable tenant ids, pass/fail) recorded in `test/GATES.md`. Phase 3C
is not gated-complete, and Phase 4 must not begin, until all four are green.

## BL-009 — Outbound media: documents cannot leave the workspace

**Status:** SHIPPED 2026-09-20. Files leave through `send_file_to_user`, which
mints a short-lived HMAC-signed `/files/…` link that Rocky serves itself
(`src/media-host.mjs`). Verified in prod: a public fetch returned the
attachment, a tampered signature returned 403, and the Caddy access log shows
two `200`s from `TwilioProxy/1.1` for one send. See `features/06-multimedia.md`
and the decision log entry of the same date.

**Residual, tracked here:** the agent sometimes reports a file as sent without
calling the tool. The always-on audience rule reduces this; it does not
eliminate it. Watch for it in real use.

<details><summary>Original 2026-09-18 write-up</summary>

### What works already

The tenant's synced Claude skills include `docx`, `pdf`, `pptx`, `xlsx` and
`docs`, loaded into OpenClaw (see BL-010). The agent can therefore produce real
documents into `tenants/<uid>/workspace/`.

### What does not

Every channel implements only `sendText(to, text)` — `channel.mjs`,
`twilio-channel.mjs`, `baileys-channel.mjs`. There is no `sendMedia`, and the
Twilio adapter sets `Body` only, never `MediaUrl`. A generated file lands in the
workspace and stays there; the user never receives it.

The provider is not the constraint. Twilio's API supports `MediaUrl` on outbound
WhatsApp, and Baileys supports media. The gap is our channel contract.

### Why this is more than adding a parameter

**Twilio fetches the media itself** — it will not accept an upload. So sending a
document requires a publicly reachable URL that Twilio can GET, which means a
new externally-exposed surface serving tenant documents. That needs:

- Signed, expiring URLs scoped to one file and one tenant. A guessable or
  long-lived URL exposes client material to anyone who finds it, which for a
  MAS/SEBI-licensed entity is a disclosure incident, not an inconvenience.
- A decision on what is servable at all. `workspace/` holds whatever the agent
  wrote; an endpoint that serves arbitrary workspace paths is a traversal
  target.
- Retention: Twilio caches fetched media. "Delete the document" must account for
  the provider's copy, which interacts with BL-002.

### Delivery ledger implications

Persist-before-send commits the exact approved **bytes** and asserts that what
was delivered equals what was stored (§6, §7). A media message breaks that
assumption: the text body and the document are separate artifacts. The ledger
would need to record the document reference and its hash, and the
persist-before-send gate would need to cover both, or explicitly state that it
covers the caption only.

### Interactions

- **BL-008** — if the channel moves to Meta Cloud API for quoted replies, its
  media model differs from Twilio's; decide the provider first.
- **BL-002** — retention and deletion must cover provider-side media copies.
- **BL-010** — some formats may need container dependencies that are absent.

### Acceptance criteria when resumed

- A document generated by a skill is delivered to WhatsApp and opens correctly
  on a phone.
- The serving URL is signed, expiring, scoped to one tenant and one file, and a
  traversal attempt outside that tenant's workspace is refused.
- The delivery ledger records what was sent, and the persist-before-send gate
  states plainly whether it covers the document bytes or only the caption.
- Deleting a document accounts for the provider's cached copy.

---

</details>

## BL-010 — Container lacks the dependencies some document skills need

**Status:** CLOSED 2026-09-21. The container produces PDF, DOCX and PPTX and all
three were delivered to a real handset. What remains is not a dependency gap but
a provider limit: WhatsApp accepts PDF, DOC, DOCX, PPTX, XLSX, JPG, PNG, MP4 and
OGG audio and nothing else, so `.csv`, `.md`, `.txt` and `.zip` are refused
before the send with a message to the user (see the 2026-09-21 media-types
decision). Reopen only if a specific skill fails for a missing binary.

### Finding

The pinned image carries `node` and `npx` and **nothing else** relevant to
document generation. Measured against `rocky-openclaw:2026.7.1-2`:

```text
python3       absent
pandoc        absent
libreoffice   absent
wkhtmltopdf   absent
node          present
npx           present
```

The tenant's synced skills include `docx`, `pdf`, `pptx` and `xlsx`. Whether
each works depends entirely on what it shells out to. A skill built around a
Node library may work as-is; one expecting `python3`, `pandoc` or LibreOffice
will fail inside the container while working on the user's own machine — and the
failure appears as the agent apologising, not as an infrastructure error.

**Not yet tested.** No document-producing skill has been run inside the
container. That test is cheap and should come before any decision here: it may
be that the Node-based skills cover the needed formats and nothing must change.

### Why not just install everything

- Image size and cold start. Cold start is ~4.4s and every tenant pays it on
  wake; LibreOffice would add hundreds of megabytes and slow the wake path that
  hibernation depends on.
- Attack surface. The container is deliberately hardened — all capabilities
  dropped, non-root, pids-limited — because it processes untrusted input.
  A document toolchain is a large amount of parsing code reachable by an agent
  acting on WhatsApp messages.
- Runtime installs are not an answer: `npx` fetching a package mid-turn makes
  turns non-deterministic and needs network egress from a hardened container.

### Acceptance criteria when resumed

- Each document skill the tenants actually use is run inside the container and
  recorded as working or failing, with the missing dependency named.
- Any dependency that must be added is baked into the pinned image, not
  installed at runtime, and the image is re-verified by the boot gate.
- Cold-start time is re-measured after any image change, because the wake
  scheduler's lead window assumes ~4.4s.

---

## BL-011 — Cron delivery relies on a public round trip, not an SSRF exception

**Status:** Open (security review deferred by decision, 2026-09-20)

**Current scope:** OpenClaw's `url-fetch` guard refuses
`private/internal/special-use IP address` destinations, which is why cron
webhook delivery to `host.docker.internal` was blocked. The pinned image
(2026.7.1-2) exposes only `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange`
and `.allowIpv6UniqueLocalRange` — verified against `openclaw config schema`.
**There is no configuration that allows loopback or private-network fetches for
that tool**, so a general allowlist was not achievable and was not attempted.

Instead, `CRON_WEBHOOK_URL` now derives from `PUBLIC_BASE_URL` when that is a
public address, so the container reaches the cron ingress over the ordinary
public route that the guard already permits. No security control was weakened.

**The deferred risk:** scheduled results now leave the host and come back over
the public internet rather than staying on the Docker bridge. The endpoint is
token-authed and TLS-terminated at Caddy, but the traffic is externally
observable as timing/volume metadata, and the ingress path is publicly
reachable rather than bridge-only. For a MAS/SEBI-regulated deployment this
should get an explicit review before scheduled jobs carry client content.

**Prerequisites for closing:**

- Decide whether scheduled output may transit a public route at all, or whether
  delivery must stay host-internal.
- If host-internal is required, the options are a host-side reader of the
  container's own state (the state directory is already a host bind mount, so no
  network hop is needed), or an upstream OpenClaw change exposing a
  private-network allow for `tools.web.fetch`.
- Confirm the cron ingress rate-limits and logs unauthenticated attempts, given
  it is now reachable from the public internet rather than the bridge only.

**Acceptance criteria:**

- A written decision on public-route versus host-internal delivery.
- If public-route is accepted: the cron ingress is rate-limited, its token is
  rotated on the same schedule as other deployment secrets, and unauthenticated
  requests are alerted rather than merely rejected.
- `cronWebhookReachable()` remains the single place that decides whether the
  configured URL can actually be reached from inside a container.

---

## BL-012 — Inbound media: images, documents and voice notes

**Status:** SHIPPED 2026-09-20, with one item still to verify. Media is fetched
on receipt into `workspace/inbox/`, recorded per kind in the transcript
(migration 005), and named to the agent by `attachmentPreamble()`. Voice notes
are transcribed in-container by whisper.cpp. Verified in prod for a document;
**the image-through-vision round trip has not been verified end to end** — that
is the open half.

<details><summary>Original write-up</summary>

**Each media type needs a different durable representation.** The transcript is
encrypted text; it cannot hold bytes, and pretending otherwise is how a ledger
starts lying about what was said:

| Type | Bytes | What the transcript stores |
|---|---|---|
| Image | tenant workspace, referenced by path | the caption, plus a marker (`[image: filename]`) and, once the agent has seen it, the agent's own description — never a fabricated caption |
| Document (pdf/docx/xlsx) | tenant workspace | caption + `[document: filename, type, size]`; extracted text only if a skill extracts it, recorded as extraction, not as the user's words |
| Voice note / audio | tenant workspace | **the transcript text, as the message body** — this is the one case where the text genuinely is what the user said |
| Video | tenant workspace | caption + marker only |

The distinction matters for search and replay: a voice note's transcript should
match a text search for its words, an image's filename should not be treated as
something the user typed.

**Voice transcription routes through OpenClaw, not an external service.** The
pinned image exposes `audio.transcription.command` and
`audio.transcription.timeoutSeconds` (verified against `openclaw config
schema`), so a local transcriber runs inside the tenant container and the audio
never crosses the tenant boundary. Claude has no audio input modality — there is
no "native" path and none should be faked. Cost: the transcriber binary and its
model must be baked into the image (same trade as BL-010).

**Images do not need transcription.** Claude has vision, so once the bytes are
in the workspace and referenced in the prompt this works directly.

**Provider differences already mapped (see BL-008/BL-009):** Twilio gives a
directly fetchable `MediaUrl{N}` with HTTP Basic auth and a ~4h signed URL;
Meta gives a media *id* that needs a second call to resolve, a Bearer token to
download, a 5-minute URL expiry and only 7 days of retention for inbound. Any
code that stores a media URL and fetches it later breaks on Meta. Fetch on
receipt, store the bytes, keep only our own path.

**Prerequisites:**

- A decision on retention for stored media (BL-002 covers transcripts; bytes are
  larger and have their own residency question).
- Transcriber + model baked into `Dockerfile.openclaw`, with the image size
  measured before and after.

**Acceptance criteria:**

- A photo with no caption produces a reply that demonstrably used the image.
- A voice note's transcript is the message body, is searchable, and replays as
  the user's words.
- A document is acknowledged by name and type even when nothing can read it.
- Each type's ledger row is distinguishable; no marker is ever stored as if the
  user had typed it.
- Media bytes never leave the tenant's own directory.

---

</details>

## BL-013 — Outbound voice: BugleRock AI calling

**Status:** Open (not started)

**Current scope:** the agent is text-only on WhatsApp. There is no outbound
voice: it cannot place a call, speak a summary, or answer a ringing number.

**What this needs that nothing else in the system has:**

- A telephony leg. Twilio Programmable Voice is the obvious path since the
  account already exists, and WhatsApp Business Calling is a separate Twilio
  channel with its own per-minute fee (`$0.005/min` inbound and outbound on top
  of Meta's connectivity fee, per Twilio's pricing page, Aug 2026).
- Text-to-speech, and speech-to-text for the caller's side. Both must run inside
  the tenant container for the same reason voice notes do (BL-012): a client's
  voice is client data and must not leave the tenant boundary.
- A turn model that tolerates real-time latency. The current loop is
  request/response over a durable ledger with a ~7s warm turn; a phone call
  needs sub-second partial responses, which the persist-before-send design
  deliberately does not provide.

**Prerequisites:**

- BL-012 lands first — inbound audio and transcription are a strict subset of
  this, and doing them twice would be waste.
- A decision on whether calls are recorded, and if so where the recording lives
  and for how long (this is a consent question in every jurisdiction BugleRock
  operates in, not only a storage one).
- Explicit sign-off that an agent may speak to a counterparty at all. A wrong
  sentence in a call cannot be edited the way a WhatsApp message can.

**Acceptance criteria:** deferred until the prerequisites are decided; scoping
this before BL-012 exists would be guesswork.

---

## BL-015 — Voice in and voice out over a cloud STT/TTS pair

**Status:** Proposal, raised by the user 2026-09-20. Not scheduled.

**The idea:** today a voice note comes in as text (BL-012) and every reply goes
out as text. Adding a cloud STT/TTS pair would let the agent both accept and
answer in voice: the user talks, the agent talks back, and the whole exchange
stays in the medium WhatsApp users already prefer for anything longer than a
sentence.

**What it would add over what exists:**

- *Inbound:* a cloud STT is multilingual, where the baked-in `base.en` is
  English-only and produces confidently wrong text on a Hindi or Kannada voice
  note — currently the worst failure mode in the media path.
- *Outbound:* nothing in the system can produce audio at all. TTS is new
  capability, not an upgrade.

**The decision this actually forces:** cloud STT/TTS sends a client's voice, and
the agent's spoken answer, to a third party. Every other part of this design
went the other way on purpose — whisper.cpp runs locally *because* voice must
not leave the host. So this is a
confidentiality decision with a product upside, not a feature choice. It needs
an answer to: may tenant audio transit an external processor, under what
contract (zero-retention, region), and disclosed to the user how?

**Shape if approved:**

- STT stays a *fallback*, not a replacement: whisper.cpp first, cloud only when
  the audio is not English or local transcription failed. Local-first keeps the
  common case on-host.
- TTS is opt-in per tenant and never the default reply mode — a spoken reply
  cannot be skimmed, searched or quoted, and the transcript must still hold the
  text.
- Both sit behind the existing channel port, so the provider is swappable and no
  vendor name reaches the core.
- Outbound audio reuses the signed-link media path already built for BL-009.

**Candidate providers** (operator's steer):

- *AssemblyAI* — STT only; strong multilingual and diarisation, which is the gap
  `base.en` leaves. No TTS, so it solves half the problem.
- *Cartesia* — low-latency TTS, and the latency matters if BL-013's calling ever
  happens; STT is the newer half of their offering.
- *Sarvam AI* — the operator's preferred direction (2026-09-21): Indian
  provider, strong Indic-language ASR, which is the exact gap `base.en` leaves
  on Hindi and Kannada voice notes. The operator has a codebase to reference.
  Data residency is the reason it may beat the US vendors here, not just
  quality — worth checking whether it can be self-hosted.
- None of these is automatically a single-vendor answer, so expect more than one
  contract and more than one data-residency review unless Sarvam covers both
  directions.

**Prerequisites:** a data-residency and retention answer for each vendor;
a decision on whether this is per tenant or org-wide.

**Relationship to other items:** BL-013 (AI calling) needs TTS too and would
share the same component — worth deciding together rather than twice. BL-014
the operator-side dictation idea was the same confidentiality
question and is dropped.

## BL-016 — Warm-container capacity has no reclamation policy

**Status:** Open, found 2026-09-21 while reviewing capacity behaviour.

**The general problem, of which cron was one instance:** a warm container is a
*cache entry* — expensive to create (~24 s), cheap to recreate, and holding
nothing that is not durable elsewhere (transcript in SQLite, credentials in the
vault, workspace on disk). We have an admission ceiling and a fixed keep-alive
timer, but **no reclamation policy**: nothing decides which entry to give up
when the pool is full. Cron-vs-interactive was the first symptom to surface and
it has a targeted fix; the underlying question — *who loses their slot, and
when* — is unanswered for every other pairing, including the common one of one
user against another.

**What is already handled:** cron never
outranks a person. `yieldSlotForInteractive()` stops a cron-warm container to
make room for interactive work, a due cron wake at capacity is queued rather
than forced, and `inFlight` is an explicit counter so a busy container is never
chosen as a victim (P5). A displaced cron job re-fires on its next wake.

**The actual gap:** eviction only ever considers **cron-warm** containers:

```js
// wake-scheduler.mjs — yieldSlotForInteractive
if (deps.warmCount() < deps.maxWarm()) return null;
if (cronWarm.size === 0) return null;        // <— nothing to take, gives up
```

When all `MAX_TENANTS_PER_HOST` slots (currently 5) hold *interactive*
containers, there is no victim, so `assertHostCapacity()` throws
`HostCapacityExceededError`. Nothing is reclaimed, even when four of those five
containers have been idle for an hour and only one is mid-turn. Capacity is
released solely by the 2-hour hibernation timer.

**Two distinct user-visible failures:**

1. *The sixth concurrent user waits for a timer.* Five tenants who exchanged one
   message each at 09:00 hold every slot until 11:00. A sixth user at 09:05 is
   refused, although the host is doing no work at all.
2. *Onboarding is refused for a capacity reason that has nothing to do with the
   new user.* `assertHostCapacity()` is also called from `provision.mjs`, so a
   brand-new person cannot sign up because five other people happen to be
   chatting. This is the worse of the two — it turns a transient load condition
   into a permanent-looking rejection at the moment of first contact.

**Why LRU is the right shape here:** the thing being reclaimed is a *cache
entry* (a warm container), and everything it holds is durable elsewhere — the
transcript is in SQLite, credentials are in the vault, the workspace is on disk.
Evicting an idle container costs its next user one cold start (~24 s, measured);
refusing them costs them the product. The asymmetry is not close.

**Design constraints any implementation must respect:**

- **Never evict a container with `inFlight > 0`**, regardless of age. Liveness
  is the counter, never a timestamp (P5) — a slow turn makes a busy container
  *look* like the stalest candidate.
- **Interactive outranks cron, and cron is still taken first.** LRU applies only
  once `cronWarm` is empty.
- **Hibernation, not removal.** The victim is `docker stop`ped, so its state,
  mounts and credential survive; waking it is a `docker start` plus a rehydrated
  MCP projection (see the 2026-09-21 wake-path fix).
- **Eviction must not stop that tenant's cron.** The host owns the wake
  schedule, so a stopped container's due job re-fires — but the mirror must be
  current *before* the stop, or the job is invisible until the tenant returns.
- **Provisioning must stop consulting the warm ceiling.** Registering a tenant
  and running a container are different lifetimes; a signup should never be
  refused because the pool is momentarily full.
- **A thrash guard.** With N+1 active users and N slots, naive LRU produces a
  cold start on every single turn. A minimum residency (say 60 s) before a
  container becomes evictable converts thrash into queueing, which is slower but
  not pathological.

**Acceptance criteria:**

- At capacity with all slots interactive and idle, a new user's first message is
  served by evicting the least-recently-used idle container, not refused.
- A container with a turn in flight is never evicted, even as the LRU victim.
- Onboarding a new tenant succeeds at warm capacity.
- An evicted tenant's due cron job still fires at its scheduled time.
- N+1 users over N slots do not produce a cold start per turn.

### Prior art — this is a solved problem class, worth reading before implementing

Serverless platforms hit exactly this and the framing is settled: **a warm
container is a cache entry, a cold start is a cache miss**, so caching theory
applies directly rather than by analogy
([FaasCache, ASPLOS '21](https://afuerst.github.io/assets/FaasCache.pdf)).

What the literature says that changes our design:

- **LRU and LFU are the industry default, and both are known to be fragile
  across workload patterns.** They ignore that entries differ in size and in
  miss cost. FaasCache instead uses Greedy-Dual-Size-Frequency, which weighs
  recency, frequency, size and the cost of recreating the entry. For us every
  container is the same size (~213 MiB) and the same miss cost (~24 s), so
  plain LRU is defensible *today* and stops being defensible the moment tenants
  differ in container weight.
- **Keep-alive duration is the bigger lever, and ours is extreme.** AWS Lambda
  historically kept containers ~5 minutes; ours is **2 hours**. With 5 slots,
  that means five users who send one message each consume the entire host for
  two hours. Shortening keep-alive is a one-line change that recovers most of
  the capacity an eviction policy would — and it should be evaluated first,
  because it is far less code than LRU and cannot mis-evict.
- **Fixed keep-alive is itself the weak design.** The research direction is
  adaptive — per-tenant keep-alive derived from observed inter-arrival times, so
  a person mid-conversation is held and a person who sent one message at 09:00
  is not ([Cold Start Latency: systematic review](https://arxiv.org/pdf/2310.08437)).
  That subsumes LRU: a well-chosen keep-alive means the pool rarely fills.
- **Size-aware partitioning** (KiSS) splits the pool so small frequent workloads
  cannot be crowded out by large rare ones. Not relevant while every tenant is
  identical; relevant the day a heavy tenant appears.
- **Deflation beats eviction where it is available** — a "hibernated" container
  that keeps its memory image compressed restarts far faster than a cold build
  ([Hibernate Container](https://arxiv.org/pdf/2305.10963)). Our `docker stop`
  already avoids a full rebuild (start is ~32 ms; the ~2.3 s is OpenClaw's own
  boot), so the equivalent win for us would come from making OpenClaw boot
  faster, not from changing the container mechanism.

**What to measure before writing any policy.** Every source above tunes against
a hit ratio, and we currently have none. Instrument first: warm-pool hit/miss
per turn, time-to-first-token split by warm vs cold, how often the pool is
actually full, and the distribution of user inter-arrival gaps. Right now the
capacity argument rests on one anecdote and arithmetic, and a policy chosen
without a hit ratio is a guess with tests.

**Open question for the product, not the code:** with `MAX_TENANTS_PER_HOST=5`
on a 2-vCPU / 3.7 GB host, LRU converts a hard refusal into latency. Past some
concurrency the honest answer is a second host, not a cleverer eviction policy.
Worth deciding what that number is before tuning the policy.

**Suggested order of work:** instrument → shorten/adapt keep-alive → decouple
provisioning from the warm ceiling → only then LRU with a residency guard.
The first three are small and may make the fourth unnecessary.

**Done 2026-09-21:** keep-alive cut from 2 hours to **20 minutes**
(`OPENCLAW_GATEWAY_IDLE_MS`). That was the lever the research pointed at: five
users sending one message each no longer hold every warm slot for the rest of
the morning. A returning user pays one ~24s cold start. Instrumentation, the
provisioning decoupling and LRU itself remain open.

---

## Removed 2026-09-21

Dropped by the operator as not worth tracking:

- **BL-003** — quoted replies to messages older than seven days
- **BL-008** — outbound quoted replies are not possible on Twilio
- **BL-014** — a desktop dictation path (no developer API, no CLI, no headless
  mode, so nothing a container can call; superseded by BL-015)

BL-003 and BL-008 are both about WhatsApp's reply gesture. What replaced them in
practice is the quote-neighbourhood replay of 2026-09-21: a reply we *can*
resolve now carries the exchange around it, and one we cannot is stated plainly
instead of guessed at.
