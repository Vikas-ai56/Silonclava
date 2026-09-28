import crypto from 'node:crypto';
import { encryptValue, decryptValue } from '../privacy/aead.mjs';
import { assertPersistable } from '../privacy/policy-guard.mjs';

export const VOICE_STATE = Object.freeze({
  REQUESTED: 'requested',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUBMITTED: 'submitted',
  RINGING: 'ringing',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const LEGAL_VOICE_TRANSITIONS = Object.freeze({
  [VOICE_STATE.REQUESTED]: Object.freeze([VOICE_STATE.APPROVED, VOICE_STATE.REJECTED]),
  [VOICE_STATE.APPROVED]: Object.freeze([
    VOICE_STATE.SUBMITTED, VOICE_STATE.FAILED, VOICE_STATE.CANCELLED,
  ]),
  [VOICE_STATE.SUBMITTED]: Object.freeze([
    VOICE_STATE.RINGING, VOICE_STATE.IN_PROGRESS, VOICE_STATE.COMPLETED,
    VOICE_STATE.FAILED, VOICE_STATE.CANCELLED,
  ]),
  [VOICE_STATE.RINGING]: Object.freeze([
    VOICE_STATE.IN_PROGRESS, VOICE_STATE.COMPLETED, VOICE_STATE.FAILED, VOICE_STATE.CANCELLED,
  ]),
  [VOICE_STATE.IN_PROGRESS]: Object.freeze([
    VOICE_STATE.COMPLETED, VOICE_STATE.FAILED, VOICE_STATE.CANCELLED,
  ]),
  [VOICE_STATE.REJECTED]: Object.freeze([]),
  [VOICE_STATE.COMPLETED]: Object.freeze([]),
  [VOICE_STATE.FAILED]: Object.freeze([]),
  [VOICE_STATE.CANCELLED]: Object.freeze([]),
});

export const VOICE_TERMINAL_STATES = Object.freeze(
  Object.entries(LEGAL_VOICE_TRANSITIONS)
    .filter(([, successors]) => successors.length === 0)
    .map(([state]) => state),
);

const VOICE_STATE_RANK = Object.freeze({
  [VOICE_STATE.REQUESTED]: 1,
  [VOICE_STATE.APPROVED]: 2,
  [VOICE_STATE.SUBMITTED]: 3,
  [VOICE_STATE.RINGING]: 4,
  [VOICE_STATE.IN_PROGRESS]: 5,
  [VOICE_STATE.REJECTED]: 6,
  [VOICE_STATE.COMPLETED]: 6,
  [VOICE_STATE.FAILED]: 6,
  [VOICE_STATE.CANCELLED]: 6,
});

const DESTINATION_RECORD = 'voice_destination';
const TASK_RECORD = 'voice_task';
const SUMMARY_RECORD = 'voice_summary';
const TRANSCRIPT_RECORD = 'voice_transcript';
const EVENT_RECORD = 'voice_event';

const CALLBACK_REF_CONTEXT = 'rocky-voice-callback:v1';

const PATCH_COLUMNS = Object.freeze({
  approvalId: 'approval_id',
  providerCallId: 'provider_call_id',
  answeredBy: 'answered_by',
  endedBy: 'ended_by',
  errorCode: 'error_code',
  submittedAt: 'submitted_at',
  completedAt: 'completed_at',
});

const nowIso = () => new Date().toISOString();

export class VoiceCallError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'VoiceCallError';
    this.code = code;
    this.detail = detail;
  }
}

function asRaceLoss(err, detail) {
  if (String(err?.code || '').startsWith('SQLITE_BUSY')) {
    return new VoiceCallError(
      'Another writer changed the voice call mid-transaction',
      'STALE_VOICE_CALL',
      { ...detail, sqliteCode: String(err.code) },
    );
  }
  return err;
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new VoiceCallError(`${field} is required`, 'INVALID_VOICE_REQUEST', { field });
  return text;
}

function seal(tenantId, record, value) {
  return JSON.stringify(encryptValue(tenantId, record, value));
}

function unseal(tenantId, record, cipherText) {
  if (cipherText == null) return null;
  return decryptValue(tenantId, record, JSON.parse(cipherText));
}

export function isVoiceState(value) {
  return Object.hasOwn(VOICE_STATE_RANK, String(value ?? ''));
}

export function isVoiceTerminal(state) {
  return VOICE_TERMINAL_STATES.includes(String(state ?? ''));
}

export function isLegalVoiceTransition(from, to) {
  const allowed = LEGAL_VOICE_TRANSITIONS[String(from ?? '')];
  return Array.isArray(allowed) && allowed.includes(String(to ?? ''));
}

export function voiceStateRank(state) {
  return VOICE_STATE_RANK[String(state ?? '')] ?? 0;
}

export function deriveCallbackRef(callKey, callbackSecret) {
  const secret = typeof callbackSecret === 'string' ? callbackSecret : '';
  if (!secret) {
    throw new VoiceCallError('callbackSecret is required', 'INVALID_VOICE_REQUEST', { field: 'callbackSecret' });
  }
  const subject = requiredText(callKey, 'callKey');
  return crypto
    .createHmac('sha256', secret)
    .update(`${CALLBACK_REF_CONTEXT}:${subject}`)
    .digest('hex');
}

export function callbackRefHash(callbackRef) {
  const ref = requiredText(callbackRef, 'callbackRef');
  return crypto.createHash('sha256').update(ref).digest('hex');
}

function projectCall(row) {
  if (!row) return null;
  return {
    callId: row.id,
    callKey: row.call_key,
    provider: row.provider,
    providerCallId: row.provider_call_id,
    approvalId: row.approval_id,
    state: row.state,
    answeredBy: row.answered_by,
    endedBy: row.ended_by,
    errorCode: row.error_code,
    hasSummary: row.summary_cipher != null,
    hasTranscript: row.transcript_cipher != null,
    recordingConsent: row.recording_consent === 1,
    requestedAt: row.requested_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function rowByCallKey(db, callKey) {
  return db.prepare('SELECT * FROM voice_calls WHERE call_key = ?').get(callKey);
}

function rowById(db, callId) {
  return db.prepare('SELECT * FROM voice_calls WHERE id = ?').get(callId);
}

function rowByRefHash(db, refHash) {
  return db.prepare('SELECT * FROM voice_calls WHERE callback_ref_hash = ?').get(refHash);
}

export function requestCall(store, {
  callKey,
  callbackSecret,
  destination,
  task,
  provider = 'bland',
  approvalId = null,
  recordingConsent = false,
} = {}) {
  const { db, tenantId } = store;
  const key = requiredText(callKey, 'callKey');
  const to = requiredText(destination, 'destination');
  const instruction = requiredText(task, 'task');
  assertPersistable(instruction);

  const callbackRef = deriveCallbackRef(key, callbackSecret);
  const refHash = callbackRefHash(callbackRef);

  const reuse = (row) => {
    if (row.callback_ref_hash !== refHash) {
      throw new VoiceCallError(
        'The recorded call for this call key was created under a different callback secret',
        'CALLBACK_REF_MISMATCH',
        { callKey: key },
      );
    }
    if (
      unseal(tenantId, DESTINATION_RECORD, row.destination_cipher) !== to ||
      unseal(tenantId, TASK_RECORD, row.task_cipher) !== instruction
    ) {
      throw new VoiceCallError(
        'A different destination or task is already recorded under this call key',
        'CALL_KEY_CONFLICT',
        { callKey: key },
      );
    }
    return {
      callId: row.id,
      callKey: key,
      state: row.state,
      callbackRef,
      created: false,
    };
  };

  const found = rowByCallKey(db, key);
  if (found) return reuse(found);

  const destinationCipher = seal(tenantId, DESTINATION_RECORD, to);
  const taskCipher = seal(tenantId, TASK_RECORD, instruction);
  const at = nowIso();

  const insert = db.transaction(() => {
    if (rowByCallKey(db, key)) return null;
    return Number(
      db.prepare(
        `INSERT INTO voice_calls
           (call_key, provider, callback_ref_hash, approval_id, destination_cipher,
            task_cipher, state, recording_consent, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key,
        String(provider),
        refHash,
        approvalId,
        destinationCipher,
        taskCipher,
        VOICE_STATE.REQUESTED,
        recordingConsent ? 1 : 0,
        at,
        at,
      ).lastInsertRowid,
    );
  });

  let callId;
  try {
    callId = insert();
  } catch (err) {
    throw asRaceLoss(err, { callKey: key });
  }
  if (callId === null) return reuse(rowByCallKey(db, key));

  return { callId, callKey: key, state: VOICE_STATE.REQUESTED, callbackRef, created: true };
}

export function transitionCall(store, callId, toState, patch = {}) {
  const { db, tenantId } = store;
  const target = String(toState ?? '');
  if (!isVoiceState(target)) {
    throw new VoiceCallError(`Unknown voice call state ${target || '<empty>'}`, 'UNKNOWN_VOICE_STATE', { callId });
  }

  const assignments = [];
  const values = [];
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    if (patch[field] === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(patch[field]);
  }
  if (patch.summary !== undefined) {
    assignments.push('summary_cipher = ?');
    values.push(patch.summary == null ? null : seal(tenantId, SUMMARY_RECORD, patch.summary));
  }
  if (patch.transcript !== undefined) {
    assignments.push('transcript_cipher = ?');
    values.push(patch.transcript == null ? null : seal(tenantId, TRANSCRIPT_RECORD, patch.transcript));
  }

  const at = nowIso();
  const run = db.transaction(() => {
    const row = rowById(db, callId);
    if (!row) throw new VoiceCallError('No such voice call', 'NO_SUCH_VOICE_CALL', { callId });
    if (!isLegalVoiceTransition(row.state, target)) {
      throw new VoiceCallError(
        `A voice call may not move from ${row.state} to ${target}`,
        'ILLEGAL_VOICE_TRANSITION',
        { callId, from: row.state, to: target },
      );
    }
    const moved = db.prepare(
      `UPDATE voice_calls SET state = ?, ${assignments.concat('updated_at = ?').join(', ')}
        WHERE id = ? AND state = ?`,
    ).run(target, ...values, at, callId, row.state);
    if (!moved.changes) {
      throw new VoiceCallError(
        'The voice call changed state while the transition was being recorded',
        'STALE_VOICE_CALL',
        { callId, expected: row.state, attempted: target },
      );
    }
    return { ...projectCall(rowById(db, callId)), from: row.state };
  });

  try {
    return run();
  } catch (err) {
    throw asRaceLoss(err, { callId, attempted: target });
  }
}

export function approveCall(store, callId, { approvalId } = {}) {
  return transitionCall(store, callId, VOICE_STATE.APPROVED, {
    approvalId: requiredText(approvalId, 'approvalId'),
  });
}

export function rejectCall(store, callId, { reason = 'REJECTED' } = {}) {
  return transitionCall(store, callId, VOICE_STATE.REJECTED, { errorCode: String(reason) });
}

export function markSubmitted(store, callId, { providerCallId = null, submittedAt = nowIso() } = {}) {
  return transitionCall(store, callId, VOICE_STATE.SUBMITTED, {
    providerCallId: providerCallId == null ? null : String(providerCallId),
    submittedAt,
  });
}

export function markFailed(store, callId, { errorCode = 'CALL_FAILED', completedAt = nowIso() } = {}) {
  return transitionCall(store, callId, VOICE_STATE.FAILED, {
    errorCode: String(errorCode),
    completedAt,
  });
}

export function cancelCall(store, callId, { reason = 'CANCELLED', completedAt = nowIso() } = {}) {
  return transitionCall(store, callId, VOICE_STATE.CANCELLED, {
    errorCode: String(reason),
    completedAt,
  });
}

export function bindProviderCallId(store, callId, providerCallId) {
  const { db } = store;
  const id = requiredText(providerCallId, 'providerCallId');
  const at = nowIso();
  const run = db.transaction(() => {
    const row = rowById(db, callId);
    if (!row) throw new VoiceCallError('No such voice call', 'NO_SUCH_VOICE_CALL', { callId });
    if (row.provider_call_id === id) return { callId: row.id, providerCallId: id, bound: false };
    if (row.provider_call_id != null) {
      throw new VoiceCallError(
        'This voice call is already bound to a different provider call id',
        'PROVIDER_CALL_ID_CONFLICT',
        { callId: row.id },
      );
    }
    try {
      db.prepare(
        'UPDATE voice_calls SET provider_call_id = ?, updated_at = ? WHERE id = ? AND provider_call_id IS NULL',
      ).run(id, at, row.id);
    } catch (err) {
      if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new VoiceCallError(
          'Another voice call already holds this provider call id',
          'PROVIDER_CALL_ID_CONFLICT',
          { callId: row.id, providerCallId: id },
        );
      }
      throw err;
    }
    return { callId: row.id, providerCallId: id, bound: true };
  });
  try {
    return run();
  } catch (err) {
    throw asRaceLoss(err, { callId });
  }
}

function enrichmentFrom(event) {
  const patch = {};
  if (event.answeredBy != null) patch.answered_by = String(event.answeredBy);
  if (event.endedBy != null) patch.ended_by = String(event.endedBy);
  if (event.errorCode != null) patch.error_code = String(event.errorCode);
  if (event.completedAt != null) patch.completed_at = String(event.completedAt);
  return patch;
}

export function recordProviderEvent(store, {
  callbackRef = null,
  callId = null,
  fingerprint,
  eventState = null,
  providerAt = null,
  providerCallId = null,
  payload,
  answeredBy = null,
  endedBy = null,
  errorCode = null,
  completedAt = null,
  summary = null,
  transcript = null,
} = {}) {
  const { db, tenantId } = store;
  const print = requiredText(fingerprint, 'fingerprint');
  if (payload === undefined) {
    throw new VoiceCallError('payload is required', 'INVALID_VOICE_EVENT', { field: 'payload' });
  }

  const refHash = callbackRef == null ? null : callbackRefHash(callbackRef);
  const target = callId != null ? rowById(db, callId) : rowByRefHash(db, refHash);
  if (!target) {
    return { matched: false, duplicate: false, applied: false, enriched: false, state: null, reason: 'unknown_call' };
  }

  const payloadCipher = seal(tenantId, EVENT_RECORD, payload);
  const summaryCipher = summary == null ? null : seal(tenantId, SUMMARY_RECORD, summary);
  const transcriptCipher = transcript == null ? null : seal(tenantId, TRANSCRIPT_RECORD, transcript);
  const at = nowIso();

  const run = db.transaction(() => {
    const row = rowById(db, target.id);
    const recorded = db.prepare(
      `INSERT OR IGNORE INTO voice_call_events
         (call_id, fingerprint, event_state, provider_at, payload_cipher, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, print, String(eventState ?? 'unknown'), providerAt, payloadCipher, at);

    if (!recorded.changes) {
      return {
        matched: true, duplicate: true, applied: false, enriched: false,
        state: row.state, reason: 'duplicate_fingerprint',
      };
    }

    const incomingRank = voiceStateRank(eventState);
    const currentRank = voiceStateRank(row.state);
    const regressive = incomingRank > 0 && incomingRank < currentRank;

    const columns = {};
    if (!regressive) {
      Object.assign(columns, enrichmentFrom({ answeredBy, endedBy, errorCode, completedAt }));
      if (summaryCipher != null) columns.summary_cipher = summaryCipher;
      if (transcriptCipher != null) columns.transcript_cipher = transcriptCipher;
    }

    let boundProviderCallId = false;
    if (providerCallId != null && row.provider_call_id == null) {
      columns.provider_call_id = String(providerCallId);
      boundProviderCallId = true;
    }

    const advances = isVoiceState(eventState) && isLegalVoiceTransition(row.state, eventState);

    if (advances) columns.state = String(eventState);

    const assignments = Object.keys(columns).map((c) => `${c} = ?`).concat('updated_at = ?');
    let updated;
    try {
      updated = db.prepare(
        `UPDATE voice_calls SET ${assignments.join(', ')} WHERE id = ? AND state = ?`,
      ).run(...Object.values(columns), at, row.id, row.state);
    } catch (err) {
      if (boundProviderCallId && String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        throw new VoiceCallError(
          'Another voice call already holds this provider call id',
          'PROVIDER_CALL_ID_CONFLICT',
          { callId: row.id, providerCallId: String(providerCallId) },
        );
      }
      throw err;
    }
    if (!updated.changes) {
      throw new VoiceCallError(
        'The voice call changed state while a provider event was being applied',
        'STALE_VOICE_CALL',
        { callId: row.id, expected: row.state },
      );
    }

    let reason = 'applied';
    if (!advances) {
      if (!isVoiceState(eventState)) reason = 'no_state_in_event';
      else if (isVoiceTerminal(row.state)) reason = 'already_terminal';
      else if (regressive) reason = 'out_of_order';
      else if (incomingRank === currentRank) reason = 'no_change';
      else reason = 'illegal_transition';
    }

    return {
      matched: true,
      duplicate: false,
      applied: advances,
      enriched: Object.keys(columns).length > (advances ? 1 : 0),
      state: advances ? String(eventState) : row.state,
      reason,
    };
  });

  try {
    return run();
  } catch (err) {
    throw asRaceLoss(err, { callId: target.id, fingerprint: print });
  }
}

export function voiceCallById(store, callId) {
  return projectCall(rowById(store.db, callId));
}

export function voiceCallByKey(store, callKey) {
  return projectCall(rowByCallKey(store.db, requiredText(callKey, 'callKey')));
}

export function voiceCallByCallbackRef(store, callbackRef) {
  return projectCall(rowByRefHash(store.db, callbackRefHash(callbackRef)));
}

export function voiceCallDestination(store, callId) {
  const row = rowById(store.db, callId);
  if (!row) return null;
  return unseal(store.tenantId, DESTINATION_RECORD, row.destination_cipher);
}

export function voiceCallTask(store, callId) {
  const row = rowById(store.db, callId);
  if (!row) return null;
  return unseal(store.tenantId, TASK_RECORD, row.task_cipher);
}

export function voiceCallSummary(store, callId) {
  const row = rowById(store.db, callId);
  if (!row) return null;
  return unseal(store.tenantId, SUMMARY_RECORD, row.summary_cipher);
}

export function voiceCallTranscript(store, callId) {
  const row = rowById(store.db, callId);
  if (!row) return null;
  return unseal(store.tenantId, TRANSCRIPT_RECORD, row.transcript_cipher);
}

export function voiceCallEvents(store, callId) {
  return store.db
    .prepare(
      `SELECT id, fingerprint, event_state, provider_at, received_at
         FROM voice_call_events WHERE call_id = ? ORDER BY id`,
    )
    .all(callId);
}

export function voiceCallEventPayload(store, eventId) {
  const row = store.db
    .prepare('SELECT payload_cipher FROM voice_call_events WHERE id = ?')
    .get(eventId);
  if (!row) return null;
  return unseal(store.tenantId, EVENT_RECORD, row.payload_cipher);
}

export function listVoiceCallsByState(store, states, limit = 200) {
  const wanted = (states || []).map((s) => String(s)).filter(isVoiceState);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  return store.db
    .prepare(
      `SELECT id, call_key, provider, provider_call_id, state, error_code,
              requested_at, submitted_at, completed_at, updated_at
         FROM voice_calls WHERE state IN (${placeholders})
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...wanted, limit)
    .map((row) => ({
      callId: row.id,
      callKey: row.call_key,
      provider: row.provider,
      providerCallId: row.provider_call_id,
      state: row.state,
      errorCode: row.error_code,
      requestedAt: row.requested_at,
      submittedAt: row.submitted_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    }));
}

export function voiceCallStateCounts(store) {
  return Object.fromEntries(
    store.db
      .prepare('SELECT state, COUNT(*) AS n FROM voice_calls GROUP BY state')
      .all()
      .map((r) => [r.state, r.n]),
  );
}
