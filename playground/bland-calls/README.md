# Bland calls playground

Reference-only Bland provider boundary. Nothing in this directory is imported
by the Rocky runtime.

Bland is an organization service. Its API key and webhook-signing secret belong
in Rocky's encrypted platform vault. The raw Bland MCP must not be projected
into tenant OpenClaw instances while they share that organization key: Bland's
call tools and logs are scoped to the key's organization, not to a Rocky tenant.

## Production wiring plan

### Call initiation

1. Add a tenant-CLI `call` resource. Operator-only configuration writes the
   Bland API key and webhook secret to the platform vault through stdin.
2. An agent call request is bound to the server-resolved tenant grant; the model
   cannot supply a tenant ID. Show the destination, purpose, maximum duration
   and recording setting to the approval layer.
3. Persist `requested`, then `approved`, in that tenant's SQLite database before
   calling Bland. Create a signed, tenant-bound callback reference and pass the
   Rocky public gateway URL as the per-call `webhook`.
4. Call `createCall`, then persist the returned provider call ID and `submitted`
   state. A crash after Bland accepts but before this update is `uncertain`; do
   not place the call again without provider-supported idempotency or operator
   reconciliation.

The callback is a Rocky endpoint, for example:

```text
https://<rocky-public-dns>/webhooks/bland/<signed-callback-reference>
```

It is not the iRock-derived Composio connector endpoint. Call initiation is an
authenticated outbound request; the webhook is for progress and completion.

### Webhook and transcript

1. Preserve the raw HTTP body and verify `X-Webhook-Signature` with HMAC-SHA256
   before parsing.
2. Resolve the signed callback reference to the tenant and internal call row.
   Provider metadata is correlation only and never tenant authority.
3. Append a `voice_call_events` row using the body fingerprint as a dedupe key.
   Accept late transcript/summary enrichment even after a terminal status, and
   never regress a terminal status because an older event arrives later.
4. Encrypt the task, phone number, provider payload, transcript and summary with
   Rocky's existing tenant-bound AEAD before inserting the reference schema.
5. Commit the final state before enqueueing a WhatsApp summary through Rocky's
   existing durable delivery path. Duplicate callbacks must not duplicate that
   delivery.

Keep the full call transcript in the call domain. Do not automatically copy it
into the WhatsApp transcript. Store a delivery summary there and expose a
tenant-bound `call transcript` action when full retrieval is requested.

Recording defaults to off. If explicitly approved, download it promptly into
tenant-owned storage and store a relative path plus checksum/retention data;
do not treat Bland's external recording URL as durable storage.

### Runtime surface

Expected resource actions are `call request`, `call status`, `call stop` and
`call transcript`. Only the narrow, tenant-bound agent actions are projected to
OpenClaw. Rocky calls Bland's REST API behind that boundary; it does not rebuild
Bland's telephony, speech or orchestration.

Do not copy the Hermes implementation unchanged:

- its signature header is obsolete (`X-Bland-Signature` instead of the current
  `X-Webhook-Signature`);
- retry timers were in-memory and disappear on restart;
- it sent Twilio notifications directly instead of using durable delivery;
- it retained external recording URLs as if they were durable.

## Files and tests

- `client.mjs`: create/get/stop provider contract and normalized results.
- `webhook.mjs`: signature verification, callback fingerprint and normalization.
- `schema.sql`: reference tables for one tenant SQLite database.
- `*.test.mjs`: synthetic provider, webhook and SQLite contract tests. They do
  not place a live call.

Before production wiring, add route tests for invalid signatures, signed
callback tenant isolation, duplicate/out-of-order callbacks, crash recovery,
approval denial, one final delivery, and a sandbox/live Bland call.

Official contracts:

- <https://docs.bland.ai/api-v1/post/calls>
- <https://docs.bland.ai/api-v1/get/calls-id>
- <https://docs.bland.ai/api-v1/post/calls-id-stop>
- <https://docs.bland.ai/tutorials/post-call-webhooks>
- <https://docs.bland.ai/tutorials/webhook-signing>
- <https://docs.bland.ai/integrations/mcp/tools>
