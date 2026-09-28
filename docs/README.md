# Rocky docs

Rocky is the multi-tenant control plane that puts a Claude agent on WhatsApp: one
isolated OpenClaw container per tenant, an encrypted per-tenant transcript, an
organization-approved MCP tool bundle, and a persist-before-send delivery path.

## Read in this order

| Doc | What it is |
|---|---|
| `CODEBASE.md` | The file-by-file map. Where does X live? |
| `features/` | How each capability actually works end to end — flows, boundaries, failure modes. Start here to understand the system. |
| `DECISIONS.md` | **The source of truth.** Every durable decision with its reasoning, rejected alternatives and the edge cases that were found. When a doc and the decision log disagree, the decision log wins. |
| `PATTERNS.md` | The project-agnostic engineering principles (P1–P12) the design keeps returning to. |
| `backlog.md` | What is not built yet, with BL-### ids. |

## Living vs historical

**Living** — kept current with the code: `README.md`, `CODEBASE.md`,
`features/**`, `DECISIONS.md`, `PATTERNS.md`, `PATTERNS-durable-work.md`,
`backlog.md`, `specs/**`, `research/**`.

**Historical** — kept for the reasoning, not as a description of today's code:
`ROCKY-codebase-audit.md`, `ROCKY-requirements-verification.md`,
`ISSUE-quoted-reply-7day.md`, `whatsapp-groups-agent-review.md`. Each carries a
banner saying so.

The phase specs and plans (`PLAN.md`, `SPEC-phase*`, `PREFLIGHT-phase3c.md`,
`HANDOFF-phase3b.md`, `BRIEF-phase3-onwards.md`) were deleted on 2026-09-20 once
`features/` and `DECISIONS.md` carried their content. Some code comments still
cite them by section (e.g. "§1.4" of the phase-3C spec); those section numbers
resolve through `DECISIONS.md` **and the tests that carry the same section
numbers**.

*Corrected 2026-09-24.* This paragraph previously said the sections resolved
through `DECISIONS.md` alone. An audit of all 29 `SPEC-phase3c` citations in
`src/` found four that it did **not** record — §2 (terminal-completion-only and
no in-turn retry), §1.5 (the session is a cache, the transcript is the memory),
§7's blocked-class list, and §5's immutable turn envelope. They are now written
down as retroactive entries R1–R9 in `DECISIONS.md`.

The deleted specs are **not** recoverable, contrary to what the decision log used
to claim: `SPEC-phase3c*`, `PREFLIGHT-phase3c.md`, `HANDOFF-phase3b.md` and
`BRIEF-phase3-onwards.md` were never committed to git (only `PLAN.md` was), and
`docs/` is not in `deploy/rsync-exclude.txt`, so `rsync --delete-after` removed the
production copies on the first deploy after 2026-09-20.

## Ground rules for changing this folder

1. A durable decision goes in `DECISIONS.md` **when it is made**, not at the end
   of a session.
2. A new capability gets a `features/` doc in the same change that ships it.
3. `CODEBASE.md` is updated whenever a file is added, moved or deleted.
4. Never put a tenant identifier, phone number, client name or secret in any
   doc. Examples use `br_…`, "the tenant", "a client".
