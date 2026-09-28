# 03 — Persistence, search and turn context

The transcript is the agent's memory. OpenClaw's own session is a cache that may
vanish with the container (P1).

## Store layout

`tenants/<id>/data/tenant.sqlite`, WAL, `synchronous = FULL` asserted on open.

| Migration | Adds |
|---|---|
| 001 | transcript ledger (conversations, messages) |
| 002 | turn state machine + delivery envelope |
| 003 | cron schedule mirror + duration model |
| 004 | inbound reply reference (`reply_to_external_id`) |
| 005 | inbound attachments (`attachments` JSON column) |
| 006 | `message_parts` — every provider message id a committed reply was delivered as. |
| 007 | the three waiting states — rebuilds `turns` with the widened CHECK. |

Migrations are ordered and checksum-verified. **Append only — never edit a
shipped migration.**

## Module boundary

```text
open.mjs          the ONLY connection path; pragmas, readonly handles
  └ store.mjs     integrity check → migrate → quarantine on corruption
       ├ queue-store.mjs     the ONLY place raw SQL is written
       ├ delivery-store.mjs  persist-before-send, delivery attempts
       ├ cron-store.mjs      mirror of OpenClaw's schedule (P8)
       ├ context-store.mjs   transcript replay + checkpoints
       ├ search-store.mjs *(removed 2026-09-22 — see `CODEBASE.md`)*    keyword search
       └ turn-context.mjs    the prompt preambles
```

A test fails the build on any `.prepare()` outside `src/tenant-data/`. Corrupt
files are quarantined as `data/corrupt-<timestamp>/`, never deleted.

Message bodies are sealed on write: policy guard first, then AES-GCM.

## Search — deliberately not an index

`search-store.mjs *(removed 2026-09-22 — see `CODEBASE.md`)*` is **decrypt-and-scan**, newest first, capped at
`SEARCH_SCAN_CAP` (20 000 messages). Terms are split on whitespace, lowercased,
AND-ed. No regex, no FTS table.

Why: an FTS index over encrypted bodies means either a plaintext shadow copy of
every message (defeating the encryption) or a bespoke encrypted index. For an
internal tool with per-tenant volumes in the thousands, a bounded scan is
correct and has no second source of truth to drift.

## What gets prepended to a turn

Built in `turn-context.mjs`, assembled in `router.mjs:284`, always in this order:

| Preamble | When | Says |
|---|---|---|
| `audiencePreamble()` | **always** | The reader is a WhatsApp user. No infrastructure talk. The user has no filesystem — a workspace path is not a deliverable; a file exists for them only after `send_file_to_user` succeeds. |
| `attachmentPreamble()` | message had media | Where the files are inside the container, and what each one is. |
| `toolAvailabilityPreamble()` | always | What is connected **right now**, in the present tense, with an explicit instruction to ignore earlier contradicting statements. |
| `quotedReplyPreamble()` | user replied to a message | The quoted text, or a note that it is older than the provider's 7-day window. |
| `relatedContextPreamble()` | `needsDisambiguation(text)` and nothing quoted | Candidate earlier messages so the agent confirms rather than guesses. |
| `assembleContext()` | `contextNeeded()` — cold or new-generation session | A bounded transcript replay (20 messages / 6 000 chars, plus the latest checkpoint), rendered `User:` / `Model response:` via `transcript-label.mjs`. |
| `interruptedTurnPreamble()` | `attempt > 1` | The previous attempt may have partly answered. |

`needsDisambiguation()` fires on ≤3 words, a strong referent ("that one", "the
deck") under 25 chars, or a weak referent under 8 — an *identification* problem,
not a retrieval one (P9). More storage would not fix it; asking does.

## Lessons paid for twice

- The tool list was read off the envelope instead of `.result`, so the agent
  refused a calendar it was holding. Unwrap at the boundary.
- The audience rule was originally folded into the tool preamble and vanished
  whenever tools were connected. Always-on rules get their own preamble.
- A 60 s tool cache was not invalidated on connect, producing "Asana connected"
  followed by "Asana not available". `invalidateToolState()` now runs on
  connect.
