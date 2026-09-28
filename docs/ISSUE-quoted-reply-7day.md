> **Historical.** A point-in-time document, kept for its reasoning. It is *not* a
> description of the current code — see `docs/features/`, `docs/CODEBASE.md`, and
> `docs/DECISIONS.md` when they disagree.

# Issue — quoted replies to messages older than 7 days

Status: open, needs a decision before the Phase 5 channel build
Owner: unassigned
Raised: 2026-09-18

## Summary

When a WhatsApp user long-presses an old message and replies to it, our webhook
needs to know *which* message they quoted. On Twilio, that information is only
supplied for messages sent in the last 7 days. Past 7 days we receive a bare
message with no pointer, even though the user can see the quote in their own
WhatsApp UI.

This is **not** a storage problem. We can retain every message forever and still
not know what was quoted, because the identifier itself is missing.

## Verified facts

**Twilio (primary source — [changelog](https://www.twilio.com/en-us/changelog/whatsapp-inbound-messages-will-now-include-reply-context)):**

Inbound WhatsApp replies add exactly two parameters:

```
OriginalRepliedMessageSid
OriginalRepliedMessageSender
```

- Verbatim: *"Only message replies to messages sent within the last 7 days will
  contain this additional context."*
- Verbatim: *"Incoming message replies to messages sent over 7 days ago will
  still be delivered, but will lack this additional information."*
- The webhook **never** contains the quoted message's text. It provides a SID
  only; the body requires a separate Twilio API fetch.

**Baileys / WhatsApp Web protocol (verified locally):**

`node_modules/@whiskeysockets/baileys/WAProto/index.d.ts:10747`

```ts
/** ContextInfo quotedMessage */
quotedMessage?: (proto.IMessage|null);
```

The **entire quoted message object arrives inline, body included**, plus
`stanzaId` and `participant`. It comes from the sending client's payload, not a
server lookup, so there is no age window. `src/baileys-channel.mjs` does not
currently read it.

## Working hypothesis — the limit is Twilio's, not WhatsApp's

WhatsApp's own protocol carries the quoted message's stanza ID inside the
inbound message (that is how the phone renders the quote bubble). Twilio must
translate that stanza ID into a Twilio `MessageSid`, which requires a lookup in
Twilio's own message store — and Twilio only retains that mapping for ~7 days.

If correct, the ceiling is a **Twilio retention artifact**, not a platform
limit, and going direct to Meta Cloud API would remove it.

**Supporting evidence, not proof:** no age limit on the inbound `context` object
is documented anywhere in Meta's Cloud API webhook reference. Absence of
documentation is not absence of a limit.

**Independent signal:** Instinct AI (Spear Street Technology) is a
text-it-directly WhatsApp assistant — therefore on an official API, not Baileys
— and was observed correctly answering a reply to a 2–3 week old message. That
is consistent with the hypothesis, but we do not know their channel provider.

## Two cheap experiments that settle this

Both are hours of work and remove all guesswork. Do them before committing to
the Phase 5 adapter.

**Experiment A — does Twilio's documented limit actually bite?**

1. Send a message to a test WhatsApp number through our Twilio sender.
2. Wait 8+ days.
3. From the phone, long-press that message and reply to it.
4. Capture the raw signed webhook payload.
5. Record whether `OriginalRepliedMessageSid` is present or absent.

**Experiment B — does Meta Cloud API age-limit `context`?**

1. Register a test number on a Meta Cloud API WABA (separate from the Twilio
   sender).
2. Same procedure, 8+ days.
3. Record whether the inbound `context.id` is populated.

If B is populated and A is not, the hypothesis is confirmed and the decision is
a channel-provider decision, not an architecture one.

## Options, ranked

| # | Option | Solves >7d? | Cost / risk |
|---|---|---|---|
| 1 | Meta Cloud API direct instead of Twilio | **If hypothesis holds** | Lose Twilio tooling; own the WABA; unproven until Experiment B |
| 2 | Detect and ask a clarifying question | No — degrades gracefully | Cheap; visible product limitation |
| 3 | Semantic resolution over our own transcript | Probabilistic | Works for distinct artifacts, unreliable for "that number" |
| 4 | Per-tenant Baileys on each user's own number | Yes, fully | **Rejected** — see below |

Options 2 and 3 compose: attempt semantic resolution, state the assumption, fall
back to asking.

## Why option 4 was rejected

Baileys links as a companion device to the user's **personal** WhatsApp account.
The agent would then:

- receive every message in every chat the user has, not only messages addressed
  to it;
- send as the user rather than as a distinct business contact;
- require the user to re-scan a QR from their phone whenever the link expires,
  which is unacceptable UX;
- need N always-on WebSockets in the host process, one per tenant, since a
  companion device cannot be demand-started;
- multiply unofficial-client ban exposure per tenant.

For a MAS CMS-licensed entity the visibility surface alone is disqualifying
without legal sign-off. Decision: stay on Twilio for BugleRock.

## What we should build regardless

These hold under every option and are already in the Phase 3C contract:

1. **Store every message keyed by provider message ID.** The Phase 3C unique key
   `(channel, channel_account, external_message_id)` already supports O(1)
   reference lookup.
2. **Never fetch quoted bodies from Twilio.** Twilio redacts message bodies on
   its own retention schedule; our copy is strictly more reliable. Within the
   7-day window, resolve `OriginalRepliedMessageSid` against our own database.
3. **On resolution, hydrate a neighbourhood, not just the one message** — the
   quoted message plus surrounding messages from that time, so the model has the
   local context the user is assuming.
4. **Detect the unresolvable case explicitly.** An inbound message with deictic
   language and no reply context should be treated as ambiguous, not answered
   confidently.

## Note for the public product

If the second product is consumer-facing, the channel decision may invert:
companion-on-your-own-number may be the actual product rather than a compliance
hazard. In that case this issue does not apply, but the privacy model, the
always-on socket cost, and the ban exposure all become primary design
constraints instead.

## References

- Twilio changelog — WhatsApp inbound reply context:
  https://www.twilio.com/en-us/changelog/whatsapp-inbound-messages-will-now-include-reply-context
- Twilio — WhatsApp reply context walkthrough:
  https://www.twilio.com/en-us/blog/whatsapp-reply-context-node-js
- Meta — Cloud API webhooks setup:
  https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
- Local: `WAProto/index.d.ts:10747`, `src/baileys-channel.mjs`
