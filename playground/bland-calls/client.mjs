const DEFAULT_BASE_URL = 'https://api.bland.ai/v1';

function required(value, name) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function callId(value) {
  const clean = required(value, 'callId');
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) throw new Error('callId is invalid');
  return clean;
}

function phoneNumber(value) {
  const clean = required(value, 'phoneNumber');
  if (!/^\+[1-9]\d{7,14}$/.test(clean)) throw new Error('phoneNumber must be E.164');
  return clean;
}

async function providerError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = String(body?.error?.message || body?.message || '').slice(0, 180);
  } catch {
    // The status is enough when Bland did not return JSON.
  }
  return new Error(`Bland request failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function request({ apiKey, path, method = 'GET', body, fetchImpl, baseUrl }) {
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: required(apiKey, 'Bland API key'),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw await providerError(response);
  return response.json();
}

/**
 * Provider-boundary prototype. Production must persist an approved request
 * before calling this function and must not expose it directly to the model.
 */
export async function createCall({
  apiKey,
  phoneNumber: destination,
  task,
  pathwayId,
  webhookUrl,
  requestId,
  from,
  voice,
  maxDuration = 15,
  record = false,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const instruction = String(task || '').trim();
  const pathway = String(pathwayId || '').trim();
  if (!instruction && !pathway) throw new Error('task or pathwayId is required');
  if (!Number.isInteger(maxDuration) || maxDuration < 1 || maxDuration > 720) {
    throw new Error('maxDuration must be an integer from 1 to 720 minutes');
  }

  const payload = {
    phone_number: phoneNumber(destination),
    ...(instruction ? { task: instruction } : {}),
    ...(pathway ? { pathway_id: pathway } : {}),
    ...(from ? { from: String(from) } : {}),
    ...(voice ? { voice: String(voice) } : {}),
    max_duration: maxDuration,
    record: Boolean(record),
    webhook: required(webhookUrl, 'webhookUrl'),
    webhook_events: ['call'],
    metadata: {
      rocky_request_id: required(requestId, 'requestId'),
    },
  };

  const result = await request({
    apiKey,
    path: '/calls',
    method: 'POST',
    body: payload,
    fetchImpl,
    baseUrl,
  });
  return {
    callId: required(result?.call_id, 'Bland call_id'),
    status: String(result?.status || result?.queue_status || 'submitted').toLowerCase(),
  };
}

function normalizeTurns(value) {
  if (!Array.isArray(value)) return [];
  return value.map((turn) => ({
    id: turn?.id ?? null,
    speaker: String(turn?.user || turn?.speaker || 'unknown'),
    text: String(turn?.text || turn?.transcript || ''),
    at: turn?.created_at || turn?.timestamp || null,
  })).filter((turn) => turn.text);
}

export function normalizeCall(result = {}) {
  return {
    callId: String(result.call_id || result.c_id || ''),
    status: String(result.status || result.queue_status || (result.completed ? 'completed' : 'unknown')).toLowerCase(),
    completed: Boolean(result.completed),
    answeredBy: result.answered_by || null,
    endedBy: result.call_ended_by || null,
    error: result.error_message || null,
    summary: result.summary || null,
    transcript: result.concatenated_transcript || null,
    turns: normalizeTurns(result.transcripts),
    recordingUrl: result.recording_url || null,
    startedAt: result.started_at || null,
    endedAt: result.end_at || result.completed_at || null,
  };
}

export async function getCall({
  apiKey,
  callId: id,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const result = await request({
    apiKey,
    path: `/calls/${encodeURIComponent(callId(id))}`,
    fetchImpl,
    baseUrl,
  });
  return normalizeCall(result);
}

export async function stopCall({
  apiKey,
  callId: id,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const cleanId = callId(id);
  const result = await request({
    apiKey,
    path: `/calls/${encodeURIComponent(cleanId)}/stop`,
    method: 'POST',
    body: {},
    fetchImpl,
    baseUrl,
  });
  const providerStatus = String(result?.status || '').toLowerCase();
  if (providerStatus !== 'success') throw new Error('Bland rejected the stop request');
  return {
    callId: cleanId,
    status: 'stop_requested',
  };
}
