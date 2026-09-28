# 09 — Workspace guardrails, activation and sessions

What the model is told before a turn starts, who writes it, and how a
conversation is ended and restarted.

## Why this exists

OpenClaw injects `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md` into the
**system prompt** (20 000 chars/file, 60 000 total). Until 2026-09-21 every
tenant carried OpenClaw's stock 9.6 KB defaults, so the authoritative layer held
generic assistant boilerplate while the product's real rules were stapled to
each user message. Four production failures came out of that gap: a fabricated
session reset, four rounds of "Linear is not available in your setup", a file
reported as sent that never was, and the agent calling its own platform's
message a phishing attempt.

## Who writes what

```text
org/templates/workspace/AGENTS.md   <!-- ROCKY-GUARDRAILS v1 START … END -->   managed
org/templates/workspace/SOUL.md     <!-- ROCKY-PERSONA v1 START … END -->      seeded once
                    │
                    ▼  src/workspace-guardrails.mjs
tenants/<id>/workspace/{AGENTS,SOUL}.md
```

- **Guardrails are managed.** Rewritten from the template on every CREATE and
  WAKE. A tenant (or the model) editing them changes nothing.
- **The persona is seeded once.** If the block is already present it is left
  alone, so a custom persona survives.
- **A model never authors either.** Deterministic templating, versioned,
  hashed — so "did tenant X have guardrail version N on date Z" is a lookup.

## The guardrails

| Tag | Rule |
|---|---|
| `<audience>` | A WhatsApp user, not an operator. No internal component names. |
| `<delivery>` | Finished files go to `outbox/`; never hand over a workspace path. |
| `<tool-honesty>` | Only a tool result is evidence. |
| `<capability-honesty>` | A connectable toolkit is never "unavailable"; no invented roadmap. |
| `<provenance>` | The platform also sends messages here. Never call the user's own system phishing. |
| `<state-claims>` | Nothing is reset except via `start_new_session`; a subagent is not a fresh session. |
| `<justification>` | Short by default, but a refusal, failure or unverifiable claim must carry its reason. |

Confidentiality and naming are deliberately **not** guardrails: the exact entity
names carry that in the persona instead.

## Verification

`verifyWorkspaceGuardrails()` looks for the marker pair in each file and
returns `{ok, missing, hash}` — the hash covers both blocks, truncated to 16
hex. It runs as a **required onboarding step** (`workspace guardrails`) on both
CREATE and WAKE, so a container with missing guardrails never serves traffic.

Markers are HTML comments, invisible in Markdown, and `toWhatsAppText()` strips
every comment before send, so a marker can never reach a user. Pinned by a test.

## Activation

```text
user pastes the Claude OAuth code
   → "Claude connected." + "Setting up your workspace — give me a moment."
   → activateTenant(): write + verify guardrails        (no Docker, no model)
   → "You are ready to go. … say 'set up my persona' …"
```

Activation owns the **workspace only**. Container bring-up stays with the
gateway, which runs its own onboarding on the next turn — one owner per
concern. It is deduped per tenant and awaitable through `whenActivated()`, so
two auth completions cannot race.

## Sessions

OpenClaw keys a session by the `user` field Rocky sends on each turn:

```text
agent:main:openresponses-user:rift-+919XXXXXXXXX
                              └────────┬───────┘
                                 Rocky controls this
```

So session identity is ours. `sessionUserFor(tenant, to)` returns
`rift-<to>` at epoch 0 — keeping every existing session — and
`rift-<to>#<epoch>` after that. `startNewSession()` bumps
`tenant.sessionEpoch`; the previous session stays on disk and remains
searchable.

- **Resume on wake** needs no code: same key, same session. Verified in
  production — one session ran 2026-09-20 13:44 → 2026-09-21 09:09 across
  several hibernation cycles and two container recreations.
- **No reset.** `session.reset` is `idle` at 90 days, i.e. effectively never.
- The agent gets `start_new_session` as a real MCP tool, because the failure it
  replaces was the model *pretending*: asked for a fresh session it spawned a
  subagent — which does get an empty session — and reported that as the user's.

## Persona skill

`org/skills/persona-setup/` ships through `skills.load.extraDirs`, which already
includes `/org/skills`. No fork, no pinned OpenClaw version, no reliance on the
`metadata.openclaw.always` flag (the docs contradict themselves on it).

The skill may write `SOUL.md`, `IDENTITY.md`, `USER.md`. It is told never to
touch the guardrail block and to say so plainly if asked to relax one.
`reference/` keeps the stock OpenClaw defaults as drafting material — read on
demand, never injected, so they cost nothing per turn.
