import crypto from 'node:crypto';

function bytes(value, name) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError(`${name} must be the raw request body as a Buffer or string`);
}

/** Verify Bland's X-Webhook-Signature against the unchanged request body. */
export function verifyWebhookSignature({ rawBody, signature, secret } = {}) {
  const key = String(secret || '');
  const supplied = String(signature || '').trim().toLowerCase();
  if (!key || !/^[a-f0-9]{64}$/.test(supplied)) return false;

  const expected = crypto.createHmac('sha256', key).update(bytes(rawBody, 'rawBody')).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'));
}

export function webhookFingerprint(rawBody) {
  return crypto.createHash('sha256').update(bytes(rawBody, 'rawBody')).digest('hex');
}

/**
 * Return only fields the call lifecycle needs. Tenant authority must come from
 * Rocky's signed callback reference, never provider metadata.
 */
export function normalizeWebhook(rawBody) {
  const raw = bytes(rawBody, 'rawBody');
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Bland webhook body is not valid JSON');
  }

  const callId = String(payload.call_id || payload.c_id || '').trim();
  if (!callId) throw new Error('Bland webhook call_id is required');
  const status = String(
    payload.status || payload.queue_status || (payload.completed ? 'completed' : 'unknown'),
  ).toLowerCase();

  return {
    fingerprint: webhookFingerprint(raw),
    callId,
    status,
    eventType: payload.event_type || null,
    completed: Boolean(payload.completed),
    answeredBy: payload.answered_by || null,
    endedBy: payload.call_ended_by || null,
    error: payload.error_message || null,
    summary: payload.summary || null,
    transcript: payload.concatenated_transcript || null,
    recordingUrl: payload.recording_url || null,
    providerAt: payload.end_at || payload.completed_at || payload.timestamp || null,
  };
}
