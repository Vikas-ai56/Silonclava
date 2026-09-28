# 06 — Multimedia

WhatsApp carries voice notes, images and documents in both directions. A
transcript is encrypted *text*; it cannot hold bytes. So each kind gets the
representation that is true for it, and the bytes live in the tenant workspace.

## Inbound

```text
Twilio webhook carries MediaUrl0..N + MediaContentType0..N
   │
   ▼ collectAttachments()                          router.mjs:128
   │   fetchInboundMedia()                         src/inbound-media.mjs
   │   • fetched NOW, with the adapter's mediaAuth() credentials
   │   • capped by ROCKY_INBOUND_MEDIA_MAX_BYTES (16 MB) and a timeout
   │   • content type taken from the RESPONSE header, not the webhook field
   ▼
tenants/<id>/workspace/inbox/<ts>-<n>-<rand>.<ext>
   │
   ▼ audio? → transcribeInContainer()         src/openclaw/tenant-transcribe.mjs
   │
   ▼ transcriptBodyFor({ caption, attachments })
```

**Never store the provider URL.** Twilio's expires in hours, Meta's in minutes,
inbound media is retained seven days. Code that keeps a URL and fetches it later
passes every test and fails in production — and breaks outright on a provider
switch.

### What the transcript records, per kind

| Kind | Stored body |
|---|---|
| audio, transcribed | `"<the transcript>\n[voice note: <file>]"` — the words **are** the body, so keyword search finds them |
| audio, not transcribed | `[voice note: <file> — not transcribed]` |
| image | `[image: <file>]` — never an invented caption |
| video | `[video: <file>]` |
| document | `[document: <name>, <type>, <bytes>]` |
| failed fetch | recorded as a failed attachment, never dropped — the user *did* send something |

The `attachments` JSON column (migration 005) carries file, kind, contentType,
bytes and host path. `attachmentPreamble()` tells the agent the container-side
path so it can open the image itself — Claude's vision reads the actual picture
rather than a second model's guess stored as if it were fact.

### Voice transcription

`rocky-transcribe` is baked into the tenant image: ffmpeg converts OGG/Opus to
16 kHz mono WAV, `whisper-cli` prints the words on stdout. Rocky execs it inside
the tenant's own container.

- Setting: `ROCKY_TRANSCRIBE_COMMAND`, default `["rocky-transcribe","{{MediaPath}}"]`,
  timeout `ROCKY_TRANSCRIBE_TIMEOUT_MS` (120 s).
- Pinned by `WHISPER_VERSION` / `WHISPER_MODEL` build args; quantised `base.en`
  is ~60 MB on disk, ~250 MB resident.
- The setting is **Rocky's, not OpenClaw's**: the pinned OpenClaw has no
  `audio.transcription` key and its config schema is strict — an unknown key
  makes every tenant container refuse to start. That is exactly how
  `cron.skipMissedJobs` took the fleet down on 2026-09-18.
- Local, not an ASR API: a client's voice does not leave the host.
- The wrapper must keep ffmpeg and whisper banners off stdout, or the ledger
  records the banner as the user's words. `--no-prints`, `--no-timestamps`,
  ffmpeg to stderr. Pinned by a test.
- `base.en` is English-only. A non-English voice note produces *wrong* text
  rather than nothing — worse than silence. Open item if it appears in practice.
- Memory, not disk, is the binding constraint on a 2-vCPU / 3.7 GB host with no
  swap. The tenant cap of 5 is what bounds concurrent transcriptions.

## Outbound

```text
agent calls send_file_to_user("report.pdf")
   │
   ▼ resolveWorkspaceFile(tenantId, relPath)        src/media-host.mjs
   │   throws "Path is outside the workspace" — THIS is the whole boundary
   ▼ mediaLinkFor() → https://<public>/files/<tenant>/<path>?e=<expiry>&s=<hmac>
   │   HMAC over path+expiry with ROCKY_MEDIA_SIGNING_KEY (per host)
   ▼ channel.sendMedia(to, url)
   ▼ Twilio fetches the URL as TwilioProxy/1.1, no credentials
   ▼ 200 / 403 tampered / 410 expired / 404 / 413 too large
```

- Twilio does not accept an upload; it fetches from a URL we publish. The file
  must be reachable for the send and not afterwards — a signed expiring link is
  the smallest thing that satisfies both. TTL `ROCKY_MEDIA_TTL_MS`, default 1 h.
- `/files/*` is routed through Caddy **ahead of the basic-auth rules**, because
  Twilio presents no credentials. Verified in the access log: two `200`s from
  `TwilioProxy/1.1` per send.
- The link outlives the send by its TTL. That window is the exposure, so it is
  kept short rather than convenient.
- **Only what the provider accepts is sent.** `mediaTypes` on the adapter lists WhatsApp's accepted set; anything else is moved to `outbox/undeliverable/` and the user is told, because `text/plain` (`.md`, `.txt`) is fetched with `200` and then dropped by WhatsApp without a trace. 43 content types are served (documents, text, images, audio, video, archives); anything human-readable falls back to `text/plain` so the provider renders it rather than rejecting an unclassifiable octet-stream.
- Twilio accepts one media item per message: multi-file delivery is several
  messages.
- **The provider fetches the URL after it accepts the message, not before.** A
  file that moves between send and fetch is a 404 by the time it is read —
  observed in production as Twilio error 63019 with three `404`s from
  `TwilioProxy/1.1`. The outbox therefore moves a file to `outbox/sent/`
  *before* minting its link, so the URL points at a location that never
  changes; a failed send moves it back for the next turn to retry.
- A static public directory was rejected — anything written there stays
  fetchable forever by anyone who learns the name, and client documents cannot
  live there.

## Reply length and attachment markers

- **1,600 characters** is the provider's body limit. Over it, Twilio rejects the
  message *asynchronously* with `21617` — the send call already returned
  success, so Rocky recorded a delivery the user never received. Observed live:
  a 3,327-char reply containing exactly what the user had asked for, dropped
  silently, with the agent insisting it had sent it. `maxBodyChars` is a declared
  provider capability (Twilio: 1600) and `enforceBodyLimit()` wraps the channel
  at the **port**, so every outbound text is split whatever the adapter — no
  adapter can forget it, and nothing in the model layer decides it. Media is
  not wrapped.
- **`MEDIA:<path>`** is OpenClaw's own attachment convention. Rocky captures the
  model's text rather than its channel, so the marker was never consumed and
  printed verbatim. `extractMediaMarkers()` strips it before commit and
  delivers what it pointed at.
- Both are also stated in the prompt layer (`<length>`, `<attachments>`), so the
  model avoids the situation and the code handles it when it doesn't.

## Provider portability

Everything provider-specific stays in the adapter: `mediaAuth()` for the fetch,
`sendMedia()` for the send. Meta Cloud API differs in the upload model and the
media lifetime, not in the shape Rocky stores — which is why nothing downstream
of `channels/port.mjs` knows a URL ever existed.
