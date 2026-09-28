# 03 — Transcript authorship

**Status:** SPEC, not built.
**Decision:** locked by the user 2026-09-22 — relabel, no schema change.

## Problem

Replayed history is rendered in the second person:

- `src/tenant-data/context-store.mjs:141-142` in `assembleContext()`
- `src/tenant-data/turn-context.mjs:41` in `quotedReplyPreamble()` — **the same
  expression, in a second renderer.** Both must change together or the two preambles
  in one prompt disagree about what "You" means.

```js
`${m.direction === 'inbound' ? 'User' : 'You'}: ${m.text}`
```

`direction` is a transport fact. The thread has two authors: the model, and Rocky
itself for replies produced before the model runs. Both are `outbound`, so both render
as `You:`.

**~25 distinct platform-authored strings are affected**, including
`providers/claude/index.mjs:24-26` (the OAuth link), `agent.mjs:8,19,23,27,40,43,55`,
`tenant-openclaw.mjs:507,796-800,812,816,826,833,863`, `onboarding.mjs:154-243`, and
the synthetic `[file sent: …]` body at `delivery-store.mjs:304`.

The mechanism: `router.mjs:396` wraps the channel in `createDeferredChannel`
(`channel.mjs:58-79`); everything sent during a turn is joined by `deferred.text()`
and committed as one `direction='outbound'` row. So any deterministic string returned
inside `runTurn` lands in the transcript and replays as `You:`.

That is what produced the phishing incident: the model was shown an OAuth link
attributed to itself, found no tool-call record, and concluded fabrication.

## Design

Two changes, both required. The relabel alone removes the false *claim*; it does not
tell the agent that the platform writes in its thread.

**1. Neutral third person, in both renderers.**

```js
`${m.direction === 'inbound' ? 'User' : 'Model response'}: ${m.text}`
```

Also `turn-context.mjs:40`: `'your earlier reply'` → `'the earlier reply'`.

**2. An always-read line in the guardrail block** (P11 — the rule is always true, so it
cannot live on a conditional branch). In `org/templates/workspace/AGENTS.md`, inside
the managed `ROCKY-GUARDRAILS` block, under `<provenance>`:

> The platform sends some messages in this thread itself — login links, setup
> notices, error messages. They appear in replayed history as model responses. If
> you have no record of sending something that is in the record, it was the
> platform, not a forgery.

This requires a `GUARDRAIL_VERSION` bump to `v3` (`src/workspace-guardrails.mjs:8`),
which rewrites and re-verifies every tenant's block via `ensureWorkspaceGuardrails` /
`verifyWorkspaceGuardrails`.

## Checkpoints — no migration needed

`saveCheckpoint` (`context-store.mjs:107`) has **no production caller** — only
`test/context-assembly.test.mjs`. Nothing in `src/` writes `context_checkpoints`, so no
stored summary contains `You:`. It stores caller text verbatim and never calls
`render()`, so a future summariser must be told to emit the new label. Record that in
DECISIONS rather than leaving it implicit.

## Budget — open decision D2

`DEFAULT_MAX_CHARS` is 6000 (`context-store.mjs:26`) and the trim loop at `:146-149`
re-renders. `Model response:` is 11 characters longer than `You:` per outbound line,
so at ~20 messages the replay window shrinks by roughly 110–220 characters. Either
accept it or raise the budget. `test/context-assembly.test.mjs:118-122` asserts
`ctx.text.length < 2000` at `maxChars: 1200` and may need its margin adjusted.

## Per-file change map

| File | Change | Drift risk |
|---|---|---|
| `src/tenant-data/context-store.mjs:141-142` | label | Low |
| `src/tenant-data/turn-context.mjs:40-41` | label + `who` | Low |
| `org/templates/workspace/AGENTS.md` | `<provenance>` line | Medium — hashed block |
| `src/workspace-guardrails.mjs:8` | `v2` → `v3` | Medium |

Nothing else renders transcripts. `search-store.mjs` returns structured rows and there
is no FTS index, so there is no derived text to re-index. `recentMessages`,
`messagesAround`, `latestCheckpoint` and `contextNeeded` all return structured data.

## Tests

| Test | Action |
|---|---|
| `test/context-assembly.test.mjs:92-93` | update the two literal assertions |
| `test/context-assembly.test.mjs:118-122` | re-check the char-budget margin |
| `test/workspace-guardrails.test.mjs:493-496` | `>>>` prefix must survive |
| `test/end-to-end-flow.test.mjs:246,272-278` | re-read before landing |
| new | both renderers use the same label — assert on source, one expression each |
| new | the guardrail block contains the provenance line at v3 |

## The mirror defect — not in scope, record it

Some platform replies are sent on the **real** channel after the turn commits, so they
are never persisted and the model cannot see them at all: `router.mjs:451-457` (media
type refusal), `tenant-activation.mjs:50-51` (readiness), `index.mjs:254`, `:512`.
The opposite failure — the agent is unaware of messages the user received. Log it in
`backlog.md`; do not fix it here.

## Docs in the same PR

`features/03-persistence-and-context.md:61` (and the stale `:56` `audiencePreamble()`,
`:59` 7-day note, `:51` line ref); `features/01-inbound-turn.md:29-36`;
`CODEBASE.md:64,66`; `DECISIONS.md` — new entry (nothing currently documents the
second-person convention as a decision, so there is nothing to supersede).

## Done criteria

- One label expression, identical in both renderers.
- A platform-authored reply replays as `Model response:`.
- The guardrail block at v3 verifies on every tenant.
- `npm test` green.
