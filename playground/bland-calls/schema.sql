PRAGMA foreign_keys = ON;

-- Reference schema for one tenant database. Sensitive values are encrypted
-- before insertion using Rocky's existing transcript/vault AEAD boundary.
CREATE TABLE voice_calls (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'bland',
  provider_call_id      TEXT UNIQUE,
  request_key           TEXT NOT NULL UNIQUE,
  approval_id           TEXT,
  callback_ref_hash     TEXT NOT NULL UNIQUE,
  destination_cipher    TEXT NOT NULL,
  task_cipher           TEXT NOT NULL,
  status                TEXT NOT NULL,
  answered_by           TEXT,
  ended_by              TEXT,
  error_code            TEXT,
  summary_cipher        TEXT,
  transcript_cipher     TEXT,
  recording_media_path  TEXT,
  recording_consent     INTEGER NOT NULL DEFAULT 0 CHECK (recording_consent IN (0, 1)),
  requested_at          TEXT NOT NULL,
  submitted_at          TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  updated_at            TEXT NOT NULL
);

CREATE TABLE voice_call_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id         TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL UNIQUE,
  event_type      TEXT,
  status          TEXT NOT NULL,
  provider_at     TEXT,
  payload_cipher  TEXT NOT NULL,
  received_at     TEXT NOT NULL
);

CREATE INDEX voice_calls_status_idx ON voice_calls(status, updated_at);
CREATE INDEX voice_call_events_call_idx ON voice_call_events(call_id, id);
