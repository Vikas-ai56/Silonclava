export const BLAND_BASE_URL = 'https://api.bland.ai/v1';
export const CREATE_CALL_PATH = '/calls';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CREATE_MAX_ATTEMPTS = 1;
export const DEFAULT_READ_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_CEILING_MS = 10_000;
export const PROVIDER_DETAIL_LIMIT = 180;

export const DEFAULT_MAX_DURATION_MINUTES = 15;
export const DEFAULT_CALL_MODEL = 'enhanced';
export const DEFAULT_CALL_VOICE = 'maya';
export const MAX_DURATION_LIMIT_MINUTES = 60;

const E164 = /^\+[1-9]\d{7,14}$/;
const PROVIDER_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class BlandError extends Error {
  constructor(message, {
    operation,
    status = null,
    retryable = false,
    placementUncertain = false,
    attempts = 0,
  } = {}) {
    super(message);
    this.name = 'BlandError';
    this.provider = 'bland';
    this.operation = operation;
    this.status = status;
    this.retryable = retryable;
    this.placementUncertain = placementUncertain;
    this.attempts = attempts;
  }
}

export function isRetryableStatus(status) {
  if (status === 408 || status === 429) return true;
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

function redactSecret(text, secret) {
  const body = String(text ?? '');
  if (!secret) return body;
  return body.split(secret).join('[redacted]');
}

function usageError(operation, message) {
  return new BlandError(`Bland ${operation} refused the request: ${message}`, {
    operation,
    status: null,
    retryable: false,
    placementUncertain: false,
    attempts: 0,
  });
}

function requiredOption(value, field, operation) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw usageError(operation, `${field} is required`);
  return text;
}

function destinationNumber(value, operation) {
  const text = requiredOption(value, 'phoneNumber', operation);
  if (!E164.test(text)) throw usageError(operation, 'phoneNumber must be in E.164 form');
  return text;
}

function providerCallId(value, operation) {
  const text = requiredOption(value, 'providerCallId', operation);
  if (!PROVIDER_CALL_ID.test(text)) throw usageError(operation, 'providerCallId is not a provider identifier');
  return text;
}

function endpointFor(baseUrl, routePath) {
  return `${String(baseUrl).replace(/\/+$/, '')}${routePath}`;
}

function parseJsonOrNull(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detailFrom(parsed, raw) {
  const errors = Array.isArray(parsed?.errors)
    ? parsed.errors.map((e) => (typeof e === 'string' ? e : e?.message || e?.error)).filter(Boolean).join('; ')
    : '';
  const message = errors || parsed?.message || parsed?.error?.message || raw;
  return String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, PROVIDER_DETAIL_LIMIT);
}

async function readProviderDetail(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return '';
  }
  return detailFrom(parseJsonOrNull(raw), raw);
}

function retryAfterMsFrom(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function backoffDelayMs({ attempt, hintedMs, retryBaseMs, retryCeilingMs }) {
  const exponential = retryBaseMs * 2 ** (attempt - 1);
  const chosen = Number.isFinite(hintedMs) ? Math.max(hintedMs, exponential) : exponential;
  return Math.min(chosen, retryCeilingMs);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptOnce({ url, method, apiKey, body, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        retryable: isRetryableStatus(response.status),
        hintedMs: retryAfterMsFrom(response),
        detail: await readProviderDetail(response),
      };
    }
    let raw = '';
    try {
      raw = await response.text();
    } catch (err) {
      if (timedOut) return { ok: false, status: null, retryable: true, reason: `timed out after ${timeoutMs}ms` };
      return {
        ok: false,
        status: response.status,
        retryable: false,
        reason: `unreadable provider response (${err?.name || 'Error'})`,
      };
    }
    const parsed = parseJsonOrNull(raw);
    if (parsed === null) {
      return {
        ok: false,
        status: response.status,
        retryable: false,
        reason: 'provider response was not JSON',
      };
    }
    if (String(parsed?.status ?? '').toLowerCase() === 'error') {
      return {
        ok: false,
        status: response.status,
        retryable: false,
        detail: detailFrom(parsed, raw),
      };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    if (timedOut) return { ok: false, status: null, retryable: true, reason: `timed out after ${timeoutMs}ms` };
    return { ok: false, status: null, retryable: true, reason: `transport failure (${err?.name || 'Error'})` };
  } finally {
    clearTimeout(timer);
  }
}

function placementUncertain(failure) {
  if (!failure) return false;
  if (failure.status === null) return true;
  return Number.isInteger(failure.status) && failure.status >= 500;
}

function exhaustedError({ operation, failure, apiKey, attempts, uncertain }) {
  const headline = failure?.status
    ? `Bland ${operation} failed (HTTP ${failure.status})`
    : `Bland ${operation} failed`;
  const because = failure?.detail || failure?.reason || '';
  return new BlandError(redactSecret(because ? `${headline}: ${because}` : headline, apiKey), {
    operation,
    status: failure?.status ?? null,
    retryable: Boolean(failure?.retryable),
    placementUncertain: Boolean(uncertain),
    attempts,
  });
}

async function callBland({
  operation,
  url,
  method,
  apiKey,
  body,
  timeoutMs,
  maxAttempts,
  retryBaseMs,
  retryCeilingMs,
  fetchImpl,
  sleepImpl,
  uncertainWhenAmbiguous = false,
}) {
  if (typeof fetchImpl !== 'function') throw usageError(operation, 'fetchImpl is not callable');
  let failure = null;
  let attempted = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempted = attempt;
    const outcome = await attemptOnce({ url, method, apiKey, body, timeoutMs, fetchImpl });
    if (outcome.ok) return outcome.value;
    failure = outcome;
    if (!outcome.retryable || attempt === maxAttempts) break;
    await sleepImpl(backoffDelayMs({
      attempt,
      hintedMs: outcome.hintedMs,
      retryBaseMs,
      retryCeilingMs,
    }));
  }
  throw exhaustedError({
    operation,
    failure,
    apiKey,
    attempts: attempted,
    uncertain: uncertainWhenAmbiguous && placementUncertain(failure),
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export async function createCall({
  apiKey,
  phoneNumber,
  task = null,
  pathwayId = null,
  webhookUrl,
  voice = DEFAULT_CALL_VOICE,
  model = DEFAULT_CALL_MODEL,
  firstSentence = null,
  waitForGreeting = false,
  from = null,
  metadata = null,
  webhookEvents = null,
  maxDurationMinutes = DEFAULT_MAX_DURATION_MINUTES,
  maxDurationLimitMinutes = MAX_DURATION_LIMIT_MINUTES,
  record = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_CREATE_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCeilingMs = DEFAULT_RETRY_CEILING_MS,
  baseUrl = BLAND_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const operation = 'create-call';
  const key = requiredOption(apiKey, 'apiKey', operation);
  const destination = destinationNumber(phoneNumber, operation);
  const webhook = requiredOption(webhookUrl, 'webhookUrl', operation);
  const instruction = typeof task === 'string' ? task.trim() : '';
  const pathway = typeof pathwayId === 'string' ? pathwayId.trim() : '';
  if (!instruction && !pathway) throw usageError(operation, 'task or pathwayId is required');
  if (instruction && pathway) throw usageError(operation, 'task and pathwayId are mutually exclusive');

  const duration = Number(maxDurationMinutes);
  if (!Number.isInteger(duration) || duration < 1 || duration > maxDurationLimitMinutes) {
    throw usageError(
      operation,
      `maxDurationMinutes must be an integer from 1 to ${maxDurationLimitMinutes}`,
    );
  }
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw usageError(operation, 'metadata must be a plain object');
  }
  if (webhookEvents != null && !Array.isArray(webhookEvents)) {
    throw usageError(operation, 'webhookEvents must be an array');
  }

  const result = await callBland({
    operation,
    url: endpointFor(baseUrl, CREATE_CALL_PATH),
    method: 'POST',
    apiKey: key,
    body: {
      phone_number: destination,
      ...(instruction ? { task: instruction } : {}),
      ...(pathway ? { pathway_id: pathway } : {}),
      ...(from ? { from: String(from) } : {}),
      ...(voice ? { voice: String(voice) } : {}),
      ...(model ? { model: String(model) } : {}),
      ...(firstSentence ? { first_sentence: String(firstSentence) } : {}),
      wait_for_greeting: Boolean(waitForGreeting),
      ...(metadata ? { metadata } : {}),
      ...(webhookEvents ? { webhook_events: webhookEvents } : {}),
      max_duration: duration,
      record: Boolean(record),
      webhook,
    },
    timeoutMs,
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_CREATE_MAX_ATTEMPTS),
    retryBaseMs,
    retryCeilingMs,
    fetchImpl,
    sleepImpl,
    uncertainWhenAmbiguous: true,
  });

  const id = typeof result?.call_id === 'string' ? result.call_id.trim() : '';
  if (!id) {
    throw new BlandError('Bland accepted the call but returned no call_id', {
      operation,
      status: 200,
      retryable: false,
      placementUncertain: true,
      attempts: positiveInteger(maxAttempts, DEFAULT_CREATE_MAX_ATTEMPTS),
    });
  }
  return {
    providerCallId: id,
    batchId: typeof result?.batch_id === 'string' ? result.batch_id : null,
    providerStatus: String(result?.status ?? 'success').toLowerCase(),
  };
}

export function normalizeCall(result = {}) {
  return {
    providerCallId: typeof result.call_id === 'string' ? result.call_id : null,
    status: typeof result.status === 'string' ? result.status.toLowerCase() : null,
    queueStatus: typeof result.queue_status === 'string' ? result.queue_status.toLowerCase() : null,
    completed: result.completed === true,
    answeredBy: typeof result.answered_by === 'string' ? result.answered_by : null,
    endedBy: typeof result.call_ended_by === 'string' ? result.call_ended_by : null,
    errorMessage: typeof result.error_message === 'string' ? result.error_message : null,
    summary: typeof result.summary === 'string' ? result.summary : null,
    transcript: typeof result.concatenated_transcript === 'string' ? result.concatenated_transcript : null,
    recordingUrl: typeof result.recording_url === 'string' ? result.recording_url : null,
    dispositionTag: typeof result.disposition_tag === 'string' ? result.disposition_tag : null,
    startedAt: typeof result.started_at === 'string' ? result.started_at : null,
    endedAt: typeof result.end_at === 'string' ? result.end_at : null,
  };
}

export async function getCall({
  apiKey,
  providerCallId: id,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_READ_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCeilingMs = DEFAULT_RETRY_CEILING_MS,
  baseUrl = BLAND_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const operation = 'get-call';
  const key = requiredOption(apiKey, 'apiKey', operation);
  const clean = providerCallId(id, operation);
  const result = await callBland({
    operation,
    url: endpointFor(baseUrl, `${CREATE_CALL_PATH}/${encodeURIComponent(clean)}`),
    method: 'GET',
    apiKey: key,
    body: undefined,
    timeoutMs,
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_READ_MAX_ATTEMPTS),
    retryBaseMs,
    retryCeilingMs,
    fetchImpl,
    sleepImpl,
  });
  return normalizeCall(result);
}

export async function stopCall({
  apiKey,
  providerCallId: id,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_READ_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCeilingMs = DEFAULT_RETRY_CEILING_MS,
  baseUrl = BLAND_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const operation = 'stop-call';
  const key = requiredOption(apiKey, 'apiKey', operation);
  const clean = providerCallId(id, operation);
  const result = await callBland({
    operation,
    url: endpointFor(baseUrl, `${CREATE_CALL_PATH}/${encodeURIComponent(clean)}/stop`),
    method: 'POST',
    apiKey: key,
    body: {},
    timeoutMs,
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_READ_MAX_ATTEMPTS),
    retryBaseMs,
    retryCeilingMs,
    fetchImpl,
    sleepImpl,
  });
  return {
    providerCallId: clean,
    providerStatus: String(result?.status ?? 'success').toLowerCase(),
    message: typeof result?.message === 'string' ? result.message.slice(0, PROVIDER_DETAIL_LIMIT) : null,
  };
}
