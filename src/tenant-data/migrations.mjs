import crypto from 'node:crypto';
import { TenantDbError } from './open.mjs';

/** The §6 turn progression. Terminal states end a turn's lifecycle. */
export const TURN_STATE = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  RESPONSE_SAVED: 'response_saved',
  SEND_STARTED: 'send_started',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DELIVERY_UNKNOWN: 'delivery_unknown',
  // Waiting states (rule 9: named after the event that ends the wait). A turn
  // in one of these holds its work but is NOT executing, so it must not block
  // the lane and must not count as in-flight.
  WAITING_SUBRUN: 'waiting_subrun',
  AWAITING_APPROVAL: 'awaiting_approval',
  RETRY_WAIT: 'retry_wait',
});

/** Parked, not running. The distinction the whole slice turns on. */
export const WAITING_STATES = Object.freeze([
  TURN_STATE.WAITING_SUBRUN,
  TURN_STATE.AWAITING_APPROVAL,
  TURN_STATE.RETRY_WAIT,
]);

/** States from which a turn must be re-executed in full (§6): everything
 *  before the response is committed. */
export const PRE_COMMIT_STATES = Object.freeze([
  TURN_STATE.QUEUED,
  TURN_STATE.CLAIMED,
  // A parked turn has committed no response, so recovery re-executes it in
  // full like any other pre-commit turn.
  TURN_STATE.WAITING_SUBRUN,
  TURN_STATE.AWAITING_APPROVAL,
  TURN_STATE.RETRY_WAIT,
]);

/** Committed but not yet confirmed delivered — re-send the saved bytes, never
 *  re-invoke the model (§6). */
export const POST_COMMIT_STATES = Object.freeze([
  TURN_STATE.RESPONSE_SAVED,
  TURN_STATE.SEND_STARTED,
]);

export const TERMINAL_STATES = Object.freeze([
  TURN_STATE.COMPLETED,
  TURN_STATE.FAILED,
  TURN_STATE.DELIVERY_UNKNOWN,
]);

/**
 * Ordered, append-only schema migrations (SPEC-phase3c §4).
 *
 * Never edit a shipped migration's SQL: the recorded checksum is compared on
 * every open, and a mismatch is a hard failure rather than a silent divergence
 * between what a tenant database actually contains and what this code assumes.
 */

const MIGRATION_001 = `
CREATE TABLE tenant_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id      TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);

-- Ordered user-visible transcript. Bodies are AES-GCM envelopes bound to the
-- tenant (§7); no plaintext body column exists, and no FTS index is created
-- over one.
CREATE TABLE messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     TEXT    NOT NULL,
  sequence            INTEGER NOT NULL,
  direction           TEXT    NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel             TEXT    NOT NULL,
  channel_account     TEXT    NOT NULL,
  external_message_id TEXT,
  body_cipher         TEXT    NOT NULL,
  retention_class     TEXT    NOT NULL DEFAULT 'standard',
  created_at          TEXT    NOT NULL
);

-- Inbound deduplication. Outbound rows carry a NULL external id until the
-- provider assigns one; SQLite treats NULLs as distinct, so they never collide.
CREATE UNIQUE INDEX ux_messages_external
  ON messages (channel, channel_account, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE UNIQUE INDEX ux_messages_sequence ON messages (conversation_id, sequence);
CREATE INDEX ix_messages_created ON messages (created_at);

-- Append-only provider observations. Never updated, never deleted by the
-- request path.
CREATE TABLE message_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  event_type    TEXT    NOT NULL,
  provider_code TEXT,
  detail        TEXT,
  observed_at   TEXT    NOT NULL
);
CREATE INDEX ix_message_events_message ON message_events (message_id, id);

-- One durable envelope per request. "request_id" is the idempotency key that
-- makes total re-execution safe to retry (§6).
CREATE TABLE turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        TEXT    NOT NULL UNIQUE,
  conversation_id   TEXT    NOT NULL,
  state             TEXT    NOT NULL CHECK (state IN
                      ('queued','running','response_saved','delivered','failed')),
  attempt           INTEGER NOT NULL DEFAULT 0,
  runtime_id        TEXT,
  runtime_generation INTEGER,
  response_message_id INTEGER REFERENCES messages (id),
  error_code        TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX ix_turns_state ON turns (state, id);
CREATE INDEX ix_turns_conversation ON turns (conversation_id, id);

-- Which source messages a coalesced turn consumed, so re-execution resubmits
-- exactly the original request.
CREATE TABLE turn_messages (
  turn_id    INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  PRIMARY KEY (turn_id, message_id)
);

CREATE TABLE delivery_attempts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  outbound_message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  attempt             INTEGER NOT NULL,
  provider_message_id TEXT,
  status              TEXT    NOT NULL,
  error_code          TEXT,
  attempted_at        TEXT    NOT NULL,
  UNIQUE (outbound_message_id, attempt)
);

-- Bounded summaries through a known message sequence. Summaries supplement the
-- transcript; they never replace it (§7).
CREATE TABLE context_checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT    NOT NULL,
  through_sequence INTEGER NOT NULL,
  summary_cipher  TEXT    NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL
);
CREATE INDEX ix_checkpoints_conversation
  ON context_checkpoints (conversation_id, through_sequence);
`;

/**
 * 002 — align `turns` with the SPEC-phase3c §6 state machine and carry the
 * immutable envelope of §5.
 *
 * 001 shipped `running`/`delivered` and had no way to express "the response is
 * committed and may already have been sent". Without `send_started` and
 * `delivery_unknown`, restart recovery cannot distinguish a turn that must be
 * re-executed from one that must only be re-sent — which would re-invoke the
 * model on a turn whose reply already reached the user.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt. Foreign keys
 * from `turn_messages` are preserved by keeping the same `id` values.
 */
const MIGRATION_002 = `
CREATE TABLE turns_new (
  id                  INTEGER PRIMARY KEY,
  request_id          TEXT    NOT NULL UNIQUE,
  conversation_id     TEXT    NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN
                        ('queued','claimed','response_saved','send_started',
                         'completed','failed','delivery_unknown')),
  attempt             INTEGER NOT NULL DEFAULT 0,
  -- Immutable turn envelope (§5). Validated on the response path before a
  -- turn is saved or sent; delivery uses this recipient, never a module
  -- variable and never an address supplied by the tenant or the model.
  recipient           TEXT,
  route               TEXT    NOT NULL DEFAULT 'openclaw',
  runtime_id          TEXT,
  runtime_generation  INTEGER,
  response_message_id INTEGER REFERENCES messages (id),
  error_code          TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

INSERT INTO turns_new
  (id, request_id, conversation_id, state, attempt, recipient, route,
   runtime_id, runtime_generation, response_message_id, error_code,
   created_at, updated_at)
SELECT
  id, request_id, conversation_id,
  CASE state
    WHEN 'running'   THEN 'claimed'
    WHEN 'delivered' THEN 'completed'
    ELSE state
  END,
  attempt, NULL, 'openclaw',
  runtime_id, runtime_generation, response_message_id, error_code,
  created_at, updated_at
FROM turns;

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;

CREATE INDEX ix_turns_state ON turns (state, id);
CREATE INDEX ix_turns_conversation ON turns (conversation_id, id);
`;

/**
 * 003 — host-owned cron scheduling state (SPEC-phase3c §3a).
 *
 * Both tables are ours. `cron_schedule_mirror` is refreshed from the
 * container's own cron store but is the authority for *when we wake*, because
 * P8 forbids resting a guarantee on a dependency's internal state — an OpenClaw
 * schema change must degrade cron visibly, not stop it silently.
 *
 * `cron_duration_model` never reads OpenClaw at all: it records the host's own
 * wake -> delivery measurement, which is the slot occupancy scheduling is
 * actually constrained by.
 */
const MIGRATION_003 = `
CREATE TABLE cron_schedule_mirror (
  job_id         TEXT    PRIMARY KEY,
  name           TEXT,
  schedule_expr  TEXT,
  schedule_tz    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at_ms INTEGER,
  refreshed_at   TEXT    NOT NULL
);
CREATE INDEX ix_cron_mirror_next ON cron_schedule_mirror (enabled, next_run_at_ms);

CREATE TABLE cron_duration_model (
  job_id       TEXT    PRIMARY KEY,
  ewma_ms      INTEGER NOT NULL,
  observations INTEGER NOT NULL DEFAULT 0,
  -- An estimate stays unproven until enough runs that one anomalous first run
  -- cannot mislabel the job permanently.
  unproven     INTEGER NOT NULL DEFAULT 1,
  last_ms      INTEGER,
  updated_at   TEXT    NOT NULL
);
`;

/**
 * Twilio sends `OriginalRepliedMessageSid` when a user uses WhatsApp's native
 * reply gesture, but only for messages sent in the last 7 days. Meta's Cloud
 * API sends the same thing as `context.id` with roughly a 30-day render
 * window. Storing the provider's id (not ours) keeps the column meaningful
 * across a provider switch, and NULL is the normal case.
 */
const MIGRATION_004 = `
ALTER TABLE messages ADD COLUMN reply_to_external_id TEXT;
CREATE INDEX ix_messages_reply_to
  ON messages (conversation_id, reply_to_external_id)
  WHERE reply_to_external_id IS NOT NULL;
`;

/**
 * What arrived with a message, as JSON: kind, stored filename, content type,
 * size, and an audio transcript when one was produced. The bytes live in the
 * tenant workspace — a transcript column holds text, and pretending a row can
 * hold an image is how a ledger starts lying about what was said.
 */
const MIGRATION_005 = `
ALTER TABLE messages ADD COLUMN attachments TEXT;
`;

/**
 * 006 — every provider message id for one committed reply.
 *
 * Twilio delivers a body over WhatsApp's limit as several messages, each with
 * its own SID, and returns only one of them from the send call. A reply to any
 * other part carried a SID we had never stored, so `quotedMessage` could not
 * resolve it and the agent was handed a reply with no quoted text. We now cut
 * the reply ourselves and record every part here.
 *
 * One row per delivered part. `messages` still holds the whole reply, so the
 * transcript is unchanged and replay stays coherent.
 */
const MIGRATION_006 = `
CREATE TABLE message_parts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id          INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  part_index          INTEGER NOT NULL,
  provider_message_id TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  UNIQUE (message_id, part_index)
);
CREATE UNIQUE INDEX ux_message_parts_provider
  ON message_parts (provider_message_id);
`;

/**
 * 007 — the three waiting states.
 *
 * SQLite cannot ALTER a CHECK constraint, so `turns` is rebuilt exactly as 002
 * did. Two differences from 002, both deliberate: every column is copied
 * straight across (002 nulled `recipient` because the envelope did not exist
 * yet), and there is no state remapping — the existing seven are already valid.
 *
 * `migrateTenantDb` toggles PRAGMA foreign_keys OFF around each migration
 * because 002's rebuild once cascade-deleted every `turn_messages` row.
 */
const MIGRATION_007 = `
CREATE TABLE turns_next (
  id                  INTEGER PRIMARY KEY,
  request_id          TEXT    NOT NULL UNIQUE,
  conversation_id     TEXT    NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN
                        ('queued','claimed','response_saved','send_started',
                         'completed','failed','delivery_unknown',
                         'waiting_subrun','awaiting_approval','retry_wait')),
  attempt             INTEGER NOT NULL DEFAULT 0,
  recipient           TEXT,
  route               TEXT    NOT NULL DEFAULT 'openclaw',
  runtime_id          TEXT,
  runtime_generation  INTEGER,
  response_message_id INTEGER REFERENCES messages (id),
  error_code          TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

INSERT INTO turns_next
  (id, request_id, conversation_id, state, attempt, recipient, route,
   runtime_id, runtime_generation, response_message_id, error_code,
   created_at, updated_at)
SELECT
  id, request_id, conversation_id, state, attempt, recipient, route,
  runtime_id, runtime_generation, response_message_id, error_code,
  created_at, updated_at
FROM turns;

DROP TABLE turns;
ALTER TABLE turns_next RENAME TO turns;

CREATE INDEX ix_turns_state ON turns (state, id);
CREATE INDEX ix_turns_conversation ON turns (conversation_id, id);
`;

const MIGRATION_008 = `
CREATE TABLE media_jobs (
  id               INTEGER PRIMARY KEY,
  message_id       INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  external_message_id TEXT NOT NULL,
  attachment_index INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  file             TEXT    NOT NULL,
  content_type     TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('queued','claimed','done','failed')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  claimed_by       TEXT,
  claimed_at       TEXT,
  result_cipher    TEXT,
  error_code       TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE (external_message_id, attachment_index)
);

CREATE INDEX media_jobs_state_idx ON media_jobs(state, id);
`;

const MIGRATION_009 = `
CREATE TABLE voice_calls (
  id                   INTEGER PRIMARY KEY,
  call_key             TEXT    NOT NULL UNIQUE,
  provider             TEXT    NOT NULL DEFAULT 'bland',
  provider_call_id     TEXT    UNIQUE,
  callback_ref_hash    TEXT    NOT NULL UNIQUE,
  approval_id          TEXT,
  destination_cipher   TEXT    NOT NULL,
  task_cipher          TEXT    NOT NULL,
  state                TEXT    NOT NULL CHECK (state IN
                         ('requested','approved','rejected','submitted','ringing',
                          'in_progress','completed','failed','cancelled')),
  answered_by          TEXT,
  ended_by             TEXT,
  error_code           TEXT,
  summary_cipher       TEXT,
  transcript_cipher    TEXT,
  recording_consent    INTEGER NOT NULL DEFAULT 0 CHECK (recording_consent IN (0,1)),
  requested_at         TEXT    NOT NULL,
  submitted_at         TEXT,
  completed_at         TEXT,
  updated_at           TEXT    NOT NULL
);

CREATE TABLE voice_call_events (
  id             INTEGER PRIMARY KEY,
  call_id        INTEGER NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  fingerprint    TEXT    NOT NULL UNIQUE,
  event_state    TEXT    NOT NULL,
  provider_at    TEXT,
  payload_cipher TEXT    NOT NULL,
  received_at    TEXT    NOT NULL
);

CREATE INDEX voice_calls_state_idx ON voice_calls(state, updated_at);
CREATE INDEX voice_call_events_call_idx ON voice_call_events(call_id, id);
`;

export const MIGRATIONS = [
  { version: 1, name: 'initial-transcript-ledger', sql: MIGRATION_001 },
  { version: 2, name: 'turn-state-machine-and-envelope', sql: MIGRATION_002 },
  { version: 3, name: 'cron-schedule-mirror-and-duration-model', sql: MIGRATION_003 },
  { version: 4, name: 'inbound-reply-reference', sql: MIGRATION_004 },
  { version: 5, name: 'inbound-attachments', sql: MIGRATION_005 },
  { version: 6, name: 'outbound-message-parts', sql: MIGRATION_006 },
  { version: 7, name: 'waiting-states', sql: MIGRATION_007 },
  { version: 8, name: 'inbound-media-jobs', sql: MIGRATION_008 },
  { version: 9, name: 'voice-call-lifecycle', sql: MIGRATION_009 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Applies pending migrations and verifies applied ones still match.
 * Each migration runs inside its own transaction together with its ledger row,
 * so a crash mid-migration leaves no half-applied version.
 */
export function migrateTenantDb(db, tenantId) {
  ensureMigrationTable(db);

  const applied = new Map(
    db.prepare('SELECT version, checksum, name FROM schema_migrations').all().map((r) => [r.version, r]),
  );

  for (const migration of MIGRATIONS) {
    const previous = applied.get(migration.version);
    const expected = checksum(migration.sql);

    if (previous) {
      if (previous.checksum !== expected) {
        throw new TenantDbError(
          `Schema migration ${migration.version} (${previous.name}) was applied with a different definition; refusing to run against an unknown schema`,
          { code: 'SCHEMA_CHECKSUM_MISMATCH' },
        );
      }
      continue;
    }

    // SQLite's prescribed table-rebuild procedure. Foreign keys must be OFF
    // across the whole rebuild: a migration that drops a parent table would
    // otherwise cascade-delete its children (002 dropping `turns` silently took
    // every `turn_messages` row with it). `PRAGMA foreign_keys` is a no-op
    // inside a transaction, so it is toggled here, outside it.
    const foreignKeysWere = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        db.exec(migration.sql);
        const violations = db.pragma('foreign_key_check');
        if (violations.length) {
          throw new TenantDbError(
            `Migration ${migration.version} left ${violations.length} foreign key violation(s)`,
            { code: 'SCHEMA_FK_VIOLATION' },
          );
        }
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, expected, new Date().toISOString());
      });
      run();
    } finally {
      if (foreignKeysWere) db.pragma('foreign_keys = ON');
    }
  }

  const unknown = [...applied.keys()].filter((v) => !MIGRATIONS.some((m) => m.version === v));
  if (unknown.length) {
    throw new TenantDbError(
      `Tenant database is at unknown schema version(s) ${unknown.join(', ')}; this build is older than the database`,
      { code: 'SCHEMA_AHEAD' },
    );
  }

  const meta = db.prepare('SELECT tenant_id FROM tenant_meta WHERE id = 1').get();
  if (!meta) {
    db.prepare('INSERT INTO tenant_meta (id, tenant_id, created_at) VALUES (1, ?, ?)').run(
      tenantId,
      new Date().toISOString(),
    );
  } else if (meta.tenant_id !== tenantId) {
    // A database opened under the wrong tenant id is a routing bug and a
    // cross-tenant data exposure; never silently continue.
    throw new TenantDbError(
      `Tenant database belongs to ${meta.tenant_id}, not ${tenantId}`,
      { code: 'TENANT_MISMATCH' },
    );
  }

  return LATEST_SCHEMA_VERSION;
}
