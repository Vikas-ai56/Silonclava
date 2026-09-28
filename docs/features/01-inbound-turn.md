# 01 — The inbound turn

The path a WhatsApp message takes from Twilio to a committed, sent reply. Every
other feature hangs off this spine.

## Flow

```text
Twilio POST /webhooks/twilio/inbound
   │
   │ 1. signature check  (HMAC-SHA1 over the CONFIGURED public URL + sorted params)
   │    src/twilio-webhook.mjs → src/channels/twilio.mjs
   ▼
 normalized inbound {from, text, externalMessageId, replyToExternalId, media[]}
   │    src/channels/port.mjs defines the shape; no Twilio field escapes the adapter
   ▼
 router.onMessage                                         src/router.mjs:~380
   │ 2. resolve sender → tenant      (allow-list, onboarding for a new sender)
   │ 3. yieldSlotForInteractive()    user traffic outranks cron
   │ 4. collectAttachments()         media fetched NOW, never stored as a URL   → [06]
   │ 5. transcriptBodyFor()          per-kind transcript representation
   ▼
 enqueueForTenant()                                  src/inbound-queue.mjs
   │ dedupe on MessageSid → save message → queue or JOIN the pending turn
   │ (a second message while one is pending coalesces; no busy ack is sent)
   ▼
 scheduler claims the turn atomically           tenant-data/queue-store.mjs
   ▼
 runTurn()                                            src/router.mjs:284
   │ 6. build the prompt, in this order:
   │      audiencePreamble()            ALWAYS — who the reader is, no filesystem
   │      attachmentPreamble()          what arrived with this message
   │      toolAvailabilityPreamble()    what is connected RIGHT NOW
   │      quotedReplyPreamble()         if the user replied to a message
   │      relatedContextPreamble()      only if the text cannot stand alone
   │      assembleContext()             transcript replay iff the session is cold
   │ 7. typing heartbeat starts (also marks the message read → blue ticks)
   │ 8. handleInbound() → agent.runAgentTurn() → tenant CLI → container
   │    output is captured by a DEFERRED channel: nothing reaches the user yet
   ▼
 toWhatsAppText(reply)          normalise markup BEFORE commit  src/whatsapp-format.mjs
   ▼
 deliverResponse()                              tenant-data/delivery-store.mjs
   │ commit bytes → response_saved → send_started → provider send → completed
   ▼
 Twilio status callback → /webhooks/twilio/status → delivery ledger
```

## Turn state machine

Every transition names the state it was planned against: the update carries
`AND state = <expected>`, and a zero-row result means another writer moved the
turn — re-read rather than overwrite. `applyProviderStatus` is the one deliberate
exemption; it exists to correct a record after the fact, so a prior-state
predicate would disable exactly what it is for. A source scan enforces this
(`test/turn-state-cas.test.mjs`).

```
queued ──> claimed ──> response_saved ──> send_started ──> completed
              │                                              └──> failed / delivery_unknown
              │
              ├──> waiting_subrun      (ends when a child run returns)
              ├──> awaiting_approval   (ends when a human decides)
              └──> retry_wait          (ends when a timer fires)
                        └── all three return to `queued` to resume
```

**Executing vs parked.** Only `claimed`, `response_saved` and `send_started` are
*executing*. The three waiting states are parked: the turn holds its work but is
running nothing, so it does not hold a container and does not block the lane.

That changes an invariant deliberately. "One active turn per tenant" is now **one
*executing* turn per tenant** — a parked turn and a running turn coexist. So a
message arriving while an earlier turn waits on you starts its own turn and is
answered immediately, instead of waiting behind it. Replies can therefore arrive
out of request order, which is the trade for not deadlocking the conversation on
a human. A resumed turn re-enters through the normal claim path, so it still
cannot run alongside a live one.

Each waiting state is named after **what ends the wait**, so a timeout and an
escalation can differ per state and "how much work is stuck on me?" is a query
(`tenant state status` → `waiting`).

**All three are pre-commit**: nothing has been committed, so a crash re-executes
rather than re-sends. Recovery treats them by what they were waiting on —
`waiting_subrun` and `retry_wait` were waiting on something in memory that died
with the process, so they requeue; `awaiting_approval` was waiting on a human,
who did not, so it is left alone and surfaced. Re-running it would ask twice.

- A crash between `response_saved` and `send_started` is **safe**: the bytes are
  on disk and `resendCommittedResponses()` replays them at boot.
- A crash after `send_started` is **uncertain**: the message may have landed.
  It is marked unknown rather than retried — `turn list` surfaces it for a human
  (P3).
- `recoverAllTenantLanes()` runs **before the channel accepts traffic**, so a
  restart never races new messages against recovery.

## Boundaries

| Boundary | Rule |
|---|---|
| Provider → core | Only `channels/port.mjs` shapes cross. Nothing downstream knows Twilio exists. |
| Core → model | The model gets a prompt, never a channel handle. Output is deferred. |
| Model → user | Only `deliverResponse()`. The committed bytes and the sent bytes are identical. |
| Commands | Matched on `commandText` — the user's own words — never on the assembled prompt. |

## How it fails

- **Signature mismatch** → 403, nothing enqueued. The URL used for validation is
  the configured public URL, never one rebuilt from request headers (a proxy can
  forge those).
- **Duplicate webhook** → `MessageSid` dedupe; Twilio retries are free.
- **Model error** → a plain apology to the user; the turn still completes so the
  lane does not wedge.
- **Turn retried** (`attempt > 1`) → `interruptedTurnPreamble()` tells the agent
  it may have partially answered before.
- **Typing bubble** stops in a `finally`, so a failed turn never leaves the user
  watching it.
