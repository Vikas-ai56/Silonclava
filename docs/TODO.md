# TODO — open work, tracked outside the backlog

Not a backlog. These are commitments already made in conversation, plus the
verification owed after the Rocky → Rocky rename. Backlog items with BL-### ids
live in `backlog.md`.

Last updated 2026-09-21 (post-cutover).

## 1. Rename verification — DONE 2026-09-21, plus cutover executed

Verified: suite green, org bundle valid, vault wire format / session key /
naming guardrail / historical docs all correctly retained, env shim universal
(0 deprecation warnings in prod), markers migrated.

Cutover executed the same day: `/home/ubuntu/rift` → `/home/ubuntu/rocky`,
`rocky-gateway.service` enabled, image retagged (no rebuild), `.env.local`
switched to `ROCKY_*`, gateway meta renamed, sidecar rebuilt. The connector
database, role, compose project and volume were **deliberately kept** as
`rift_connector` / project `rift` — a wire identity, not branding.

Three defects surfaced during the cutover and are fixed: the compose file
pointed at a `rocky_connector` database that does not exist; `scripts/compose.mjs`
hardcoded `docker compose`, absent on the host; and two swapped decorators in
`composio_gateway.py` broke every Composio lookup once the sidecar was rebuilt.

**Lesson recorded:** "pre-existing" is not "harmless". Those two decorator bugs
sat uncommitted in the working tree, invisible while the old image kept running,
and went live the moment anything rebuilt. A failing test in a subsystem we are
about to redeploy is a blocker, not a footnote.

### Original checklist (kept for the record)

Baseline to compare against: **435 tests, 423 pass, 0 fail, 12 skipped**.

- [x] Re-run `npm test`. **495 pass / 0 fail** as of 2026-09-22.
- [ ] Diff the working tree against Codex's own inventory. Anything it touched
      that is not in its report is drift — flag it, do not silently accept.
- [x] `org` rebuilt after the guardrail v3 edit — bundle `2026.09.22-rocky.6`.
- [ ] No user-facing string says Rocky: `src/onboarding.mjs`, `public/**/app.js`,
      `org/templates/workspace/**`, and every quoted literal that can reach a user.
- [x] Env vars: every `RIFT_*` name is gone from `.env.example` and `.env.local`.
      `src/product-env.mjs` still carries the fallback and is queued for deletion.
- [ ] Prod compatibility: the 16 `ROCKY_*` vars in prod's `.env.local` must still
      be read after deploy. Confirm before restarting anything.
- [x] Marker tags: `ensureWorkspaceGuardrails` now **renames** a legacy marker in
      place instead of accepting it forever, so the shim terminates. Unmanaged
      `SOUL.md` personas survive the rename. Run on all local workspaces; prod
      already carried only `ROCKY-*`.
- [x] ~~Untouched, by agreement~~ — **superseded 2026-09-22**, the user chose full
      consistency before onboarding. See `DECISIONS.md`.
      - [x] `src/privacy/aead.mjs` — envelope **v2** (`rocky-vault:v2:`, `_rockyVault`),
            reads v1, migrated by `vault migrate-envelopes`
      - [x] `sessionUserFor()` — now `rocky-<phone>`; both sites moved together
      - container/image names, `rocky-gateway.service`, `/home/ubuntu/rocky`, `logs/rocky.log`
      - the `<naming>` guardrail sentences (they must name the old word to forbid it)
      - historical entries in `DECISIONS.md` and `features/**`
- [x] Runtime cutover runbook delivered and reviewed. Not executed.
- [ ] Connector rename: `docs/RUNBOOK-connector-rename.md` — rehearsed against a
      throwaway database 2026-09-22 (schema, indexes and sequence identical;
      sidecar healthy against the renamed DB). **Not executed on the live stack.**

## 2. Prod verification of everything shipped 2026-09-21

Restart, then run the script end to end and read the logs after each step.

- [ ] Container comes up as `rocky-oc-aws1-…` from the retagged image
- [ ] Guardrails **v3** applied on create; hash recorded; no marker in any reply
- [ ] Agent answers as **Rocky** and never says *Rift*, even when the prompt does
- [ ] Model/stack disclosure refused in one line, without cageyness
- [ ] Long reply (>1600 chars) arrives as several messages, none dropped
- [ ] `MEDIA:` marker never printed; the file it named is delivered
- [ ] Documents of several types round-trip: `.md`, `.docx`, `.pptx`, `.csv`, `.png`
- [ ] `start_new_session` bumps the epoch and the next turn has no history
- [ ] Persona skill loads from `extraDirs` and is invoked by name
- [ ] Post-auth activation sends both messages in order

## 3. Known gaps, decided but not built

- [x] **No deprovision command.** DONE — `tenant user deprovision`, dry-run by default, operator-only, archives rather than deletes. Removing a tenant means hand-editing
      `tenants/index.json` (both `byJid` and `byPhone`) and deleting the
      directory. Two steps that must agree, done by hand, on production — the
      index pointing at a missing directory errors instead of re-onboarding.
      `tenant user deprovision <id>` should do it atomically, with a backup and
      an audit line.

- [x] **Context replay ignores the session epoch.** DONE — `sessionFromSequence` bounds replay, related-context and its search. `assembleContext()` replays
      the last 20 messages on a generation change, so a cold container after
      `start_new_session` can re-inject the conversation the user just ended.
      Replay and keyword search must both be scoped to the current epoch.
- [x] **`turn-context.mjs` cleanup.** DONE — 181→101 lines, three exports; audience rule now only in the managed block. `audiencePreamble()` now duplicates the
      managed guardrails — remove it from the turn. Delete `relatedContext()`
      and `needsDisambiguation()`: word-count heuristics doing a job the model
      does better with its own history.
- [ ] **Existing tenants keep 9.6 KB of stock boilerplate** below the guardrail
      block (~12.6 KB total). Decide: trim to template, or leave as starting
      material. New tenants already get 3 KB.
- [ ] **Existing tenants' `IDENTITY.md` still says Rocky.** The `<naming>`
      guardrail overrides it; a one-time file migration is still owed.
- [x] **`eslint` with `no-undef`.** DONE — wired as `pretest`; found a fourth live ReferenceError on install. `test/no-undefined-identifiers.test.mjs`
      only checks module scope — it passed while `to is not defined` was live
      in production. The guard advertises more than it delivers.
- [ ] **Internal-identifier leak detector.** Log (do not mutate) when a reply
      contains a model name, `openclaw`, `composio` or a container name, so we
      can measure before deciding to filter.

## 4. Standing requirement — BugleRock proprietary tools and MCPs

The workspace template must carry a section describing BugleRock-built tools and
MCP servers so the agent has context on them. Not yet integrated, so the section
stays present-but-empty until those ship. This is a requirement to design for
now, not a feature request: when the proprietary tools land, the agent must
already know how to talk about them and when to reach for them, on both the
BugleRock and personal persona tracks.

## 5. Memory and cross-session context

- [ ] **`MEMORY.md` has never been written** because dreaming — its only writer
      — is not scheduled (`openclaw cron list` → none), and the container
      hibernates through the default 03:00 sweep anyway. Decide whether to
      enable it, and how it survives hibernation.
- [ ] **Cross-session memory** should move to OpenClaw's own store
      (`memory_search`/`memory_get`, hybrid keyword + vector) rather than our
      transcript replay. Blocked on one decision: vector search needs an
      embeddings provider, and every option except local Ollama sends client
      text to a third party — the same call as BL-015's STT/TTS.
