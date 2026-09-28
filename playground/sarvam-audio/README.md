# Sarvam audio playground

Reference-only STT/TTS client. Nothing under this directory is imported by the
runtime.

Sarvam is a default organization service, not a user connector. There is one
firm-managed API key and no tenant login, consent link, Composio connection or
per-user setup. Every admitted tenant receives the capability through the host
speech service; tenant isolation still controls which files it may process.

## Production wiring plan

### Inbound voice note

1. Keep Twilio download and tenant-path validation in `src/inbound-media.mjs`.
2. After the file is saved, persist a tenant-owned `media_job` keyed by the
   provider message ID and return the webhook response. Do not wait for Sarvam.
3. A bounded host worker claims the job, reads the organization Sarvam key from
   the encrypted platform vault and calls `transcribeFile`.
4. On success, enqueue the original inbound message once with the transcript and
   attachment. On terminal failure, enqueue it once with the existing
   `not transcribed` marker. Provider retries find the same job.
5. Use synchronous `/speech-to-text` for audio under 30 seconds. Longer voice
   notes require Sarvam Batch STT; do not block a webhook while polling it.

Recorded and forwarded voice notes use the same media pipeline. Twilio supplies
`MediaUrl0` and `MediaContentType0` for both; forwarded messages additionally
carry `Forwarded=true` or `FrequentlyForwarded=true`. Preserve those flags on
the attachment/message and label the transcript as forwarded. The words in a
forwarded clip must not be represented as if the WhatsApp sender spoke them.

This needs a small durable preprocessing state because the current
`router.mjs` calls STT before message persistence and dedupe. Replacing the stub
inline would create a timeout/duplicate-call window.

### Outbound voice reply

1. Add a `speech` tenant-CLI resource. `speech synthesize` receives text through
   the bound in-process client, never argv, and resolves the tenant from its
   grant.
2. Read the organization Sarvam key from the platform vault. The agent never
   receives it.
3. Call `synthesizeToFile` with an output path already confined to that tenant's
   `workspace/outbox/`; default to Bulbul v3, `en-IN`, and MP3.
4. Return only the relative file name. Existing `deliverOutbox()` performs the
   signed-link Twilio send, dedupe and outbound-media recording.
5. Initially synthesize only when the user explicitly asks for a voice reply.
   Automatic “voice in → voice out” should be a later tenant preference.

### Credential and configuration

- Store one firm-owned Sarvam API subscription key as an encrypted platform
  vault record, configured through an operator-only `tenant speech configure`
  action reading stdin. There is no tenant-side connect action.
- Non-secret defaults: STT model/mode/language, TTS model/speaker/language,
  request timeout, retry limit and maximum concurrent calls.
- Never put the key in OpenClaw config, a tenant mount, logs, audit output or a
  model prompt.

### Required tests before wiring

- Provider contract tests for multipart STT and binary-stream TTS.
- Duplicate Twilio delivery creates one media job and one Sarvam request.
- Both sender-recorded and forwarded Twilio voice-note fixtures take the audio
  path; forwarded provenance survives persistence and reaches the prompt.
- Crash/restart recovers claimed media jobs.
- Tenant A cannot resolve tenant B's input or output path.
- 403 is terminal/configuration failure; 429/5xx/timeouts retry with a bound;
  malformed/empty output becomes the explicit fallback.
- TTS failure leaves no partial outbox file; successful MP3 passes the existing
  Twilio media allowlist and outbox delivery tests.

Official contracts:

- <https://docs.sarvam.ai/api-reference/speech-to-text/transcribe>
- <https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api>
- <https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream>
- <https://docs.sarvam.ai/api-reference/authentication>
