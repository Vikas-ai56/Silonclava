import crypto from 'node:crypto';
import { VOICE_STATE } from '../tenant-data/voice-store.mjs';

export const SIGNATURE_HEADERS = Object.freeze(['x-webhook-signature', 'x-bland-signature']);
export const DEFAULT_REPLAY_TOLERANCE_SECONDS = 900;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const DIGEST_BYTES = 32;
const HEX_DIGEST = /^[a-f0-9]{64}$/;

export const EVENT_KIND = Object.freeze({
  POST_CALL: 'post_call',
  STREAM: 'stream',
  UNKNOWN: 'unknown',
});

export const CALL_STATUS_TO_STATE = Object.freeze({
  completed: VOICE_STATE.COMPLETED,
  failed: VOICE_STATE.FAILED,
  busy: VOICE_STATE.FAILED,
  'no-answer': VOICE_STATE.FAILED,
  canceled: VOICE_STATE.CANCELLED,
  cancelled: VOICE_STATE.CANCELLED,
});

export const QUEUE_STATUS_TO_STATE = Object.freeze({
  new: VOICE_STATE.SUBMITTED,
  queued: VOICE_STATE.SUBMITTED,
  allocated: VOICE_STATE.SUBMITTED,
  started: VOICE_STATE.IN_PROGRESS,
  complete: VOICE_STATE.COMPLETED,
  pre_queue_error: VOICE_STATE.FAILED,
  queue_error: VOICE_STATE.FAILED,
  call_error: VOICE_STATE.FAILED,
  complete_error: VOICE_STATE.FAILED,
});

export class WebhookBodyError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'WebhookBodyError';
    this.code = 'WEBHOOK_RAW_BODY_REQUIRED';
  }
}

export function rawBodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new WebhookBodyError(
    'The webhook body must be the exact bytes received; a parsed object cannot be verified',
  );
}

export function webhookFingerprint(rawBody) {
  return crypto.createHash('sha256').update(rawBodyBytes(rawBody)).digest('hex');
}

function headerValue(headers, names) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = names.map((n) => String(n).toLowerCase());
  for (const [key, value] of Object.entries(headers)) {
    if (!wanted.includes(String(key).toLowerCase())) continue;
    const found = Array.isArray(value) ? value[0] : value;
    if (found != null && String(found).trim()) return String(found).trim();
  }
  return null;
}

function constantTimeEqualsHex(expected, supplied) {
  if (!HEX_DIGEST.test(supplied)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(supplied, 'hex');
  if (a.length !== DIGEST_BYTES || b.length !== DIGEST_BYTES) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyWebhookSignature({
  rawBody,
  secret,
  headers = null,
  signature = null,
  signatureHeaders = SIGNATURE_HEADERS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const bytes = rawBodyBytes(rawBody);
  const key = typeof secret === 'string' ? secret : '';
  if (!key) return { ok: false, reason: 'missing_secret' };
  if (bytes.length > maxBodyBytes) return { ok: false, reason: 'body_too_large' };

  const supplied = String(signature ?? headerValue(headers, signatureHeaders) ?? '').trim().toLowerCase();
  if (!supplied) return { ok: false, reason: 'missing_signature' };

  const expected = crypto.createHmac('sha256', key).update(bytes).digest('hex');
  if (!constantTimeEqualsHex(expected, supplied)) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, reason: 'verified', fingerprint: webhookFingerprint(bytes) };
}

export function withinReplayWindow(timestamp, {
  toleranceSeconds = DEFAULT_REPLAY_TOLERANCE_SECONDS,
  now = Date.now(),
} = {}) {
  const raw = String(timestamp ?? '').trim();
  if (!raw) return { ok: false, reason: 'missing_timestamp' };
  let millis;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    millis = raw.length >= 13 ? numeric : numeric * 1000;
  } else {
    millis = Date.parse(raw);
  }
  if (!Number.isFinite(millis)) return { ok: false, reason: 'malformed_timestamp' };
  const skewMs = now - millis;
  if (Math.abs(skewMs) > toleranceSeconds * 1000) {
    return { ok: false, reason: 'outside_replay_window', skewMs };
  }
  return { ok: true, reason: 'fresh', skewMs };
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function callStatusToState(status) {
  return CALL_STATUS_TO_STATE[String(status ?? '').trim().toLowerCase()] ?? null;
}

export function queueStatusToState(queueStatus) {
  return QUEUE_STATUS_TO_STATE[String(queueStatus ?? '').trim().toLowerCase()] ?? null;
}

function classify(payload) {
  const hasPostCallShape =
    Object.hasOwn(payload, 'completed') ||
    Object.hasOwn(payload, 'status') ||
    Object.hasOwn(payload, 'concatenated_transcript') ||
    Object.hasOwn(payload, 'transcripts');
  if (hasPostCallShape) return EVENT_KIND.POST_CALL;
  if (Object.hasOwn(payload, 'category')) return EVENT_KIND.STREAM;
  return EVENT_KIND.UNKNOWN;
}

export function parseWebhookEvent(rawBody) {
  const bytes = rawBodyBytes(rawBody);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new WebhookBodyError('The webhook body is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookBodyError('The webhook body must be a JSON object');
  }

  const kind = classify(payload);
  const status = firstString(payload.status);
  const queueStatus = firstString(payload.queue_status);
  const eventState = kind === EVENT_KIND.POST_CALL
    ? callStatusToState(status) ?? queueStatusToState(queueStatus)
    : null;

  return {
    fingerprint: webhookFingerprint(bytes),
    kind,
    providerCallId: firstString(payload.call_id, payload.c_id),
    status,
    queueStatus,
    eventState,
    category: firstString(payload.category),
    logLevel: firstString(payload.log_level),
    message: firstString(payload.message),
    answeredBy: firstString(payload.answered_by),
    endedBy: firstString(payload.call_ended_by),
    errorCode: firstString(payload.error_message),
    summary: firstString(payload.summary),
    transcript: firstString(payload.concatenated_transcript),
    recordingUrl: firstString(payload.recording_url),
    dispositionTag: firstString(payload.disposition_tag),
    completedAt: firstString(payload.end_at, payload.completed_at),
    providerAt: firstString(payload.end_at, payload.completed_at, payload.started_at, payload.created_at),
    payload,
  };
}
