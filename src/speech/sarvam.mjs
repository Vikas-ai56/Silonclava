import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SARVAM_BASE_URL = 'https://api.sarvam.ai';
export const SARVAM_AUTH_HEADER = 'api-subscription-key';
export const SPEECH_TO_TEXT_PATH = '/speech-to-text';
export const TEXT_TO_SPEECH_STREAM_PATH = '/text-to-speech/stream';

export const MAX_TTS_CHARACTERS = 3500;
export const SUPPORTED_TTS_CODECS = Object.freeze([
  'mp3', 'linear16', 'mulaw', 'alaw', 'opus', 'flac', 'aac', 'wav',
]);

export const DEFAULT_STT_MODEL = 'saaras:v3';
export const DEFAULT_STT_MODE = 'transcribe';
export const DEFAULT_STT_LANGUAGE = 'unknown';
export const DEFAULT_TTS_MODEL = 'bulbul:v3';

const BULBUL_V3_SPEAKERS = Object.freeze([
  'aditya', 'ritu', 'ashutosh', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran',
  'kavya', 'amit', 'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit',
  'roopa', 'kabir', 'aayan', 'shubh', 'advait', 'anand', 'tanya', 'tarun', 'sunny',
  'mani', 'gokul', 'vijay', 'shruti', 'suhani', 'mohit', 'kavitha', 'rehan', 'soham',
  'rupali',
]);
export const DEFAULT_TTS_SPEAKER = 'anand';
export const DEFAULT_TTS_LANGUAGE = 'en-IN';
export const MODEL_SPEAKERS = Object.freeze({ 'bulbul:v3': BULBUL_V3_SPEAKERS });

export const DEFAULT_TTS_CODEC = 'mp3';

export const CODEC_SAMPLE_RATES = Object.freeze({
  opus: Object.freeze([8000, 12000, 16000, 24000, 48000]),
  mulaw: Object.freeze([8000]),
  alaw: Object.freeze([8000]),
});

export const DEFAULT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_MS = 500;
export const DEFAULT_RETRY_CEILING_MS = 8_000;
export const PROVIDER_DETAIL_LIMIT = 180;

export class SarvamError extends Error {
  constructor(message, { operation, status = null, retryable = false, attempts = 1 } = {}) {
    super(message);
    this.name = 'SarvamError';
    this.provider = 'sarvam';
    this.operation = operation;
    this.status = status;
    this.retryable = retryable;
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
  return new SarvamError(`Sarvam ${operation} refused the request: ${message}`, {
    operation,
    status: null,
    retryable: false,
    attempts: 0,
  });
}

function requiredOption(value, field, operation) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw usageError(operation, `${field} is required`);
  return text;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
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

async function readProviderDetail(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return '';
  }
  const parsed = parseJsonOrNull(raw);
  const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error?.code ?? raw;
  return String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, PROVIDER_DETAIL_LIMIT);
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

async function attemptOnce({ url, apiKey, buildRequest, readSuccess, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const timeoutFailure = () => ({
    ok: false,
    status: null,
    retryable: true,
    reason: `timed out after ${timeoutMs}ms`,
  });
  try {
    const request = buildRequest();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...request.headers, [SARVAM_AUTH_HEADER]: apiKey },
      body: request.body,
      signal: controller.signal,
    });
    if (response.ok) {
      try {
        return { ok: true, value: await readSuccess(response) };
      } catch (err) {
        if (timedOut) return timeoutFailure();
        return {
          ok: false,
          status: response.status,
          retryable: false,
          reason: `unreadable provider response (${err?.name || 'Error'})`,
        };
      }
    }
    return {
      ok: false,
      status: response.status,
      retryable: isRetryableStatus(response.status),
      hintedMs: retryAfterMsFrom(response),
      detail: await readProviderDetail(response),
    };
  } catch (err) {
    if (timedOut) return timeoutFailure();
    return {
      ok: false,
      status: null,
      retryable: true,
      reason: `transport failure (${err?.name || 'Error'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function exhaustedError({ operation, failure, apiKey, attempts }) {
  const headline = failure?.status
    ? `Sarvam ${operation} failed (HTTP ${failure.status})`
    : `Sarvam ${operation} failed`;
  const because = failure?.detail || failure?.reason || '';
  return new SarvamError(redactSecret(because ? `${headline}: ${because}` : headline, apiKey), {
    operation,
    status: failure?.status ?? null,
    retryable: Boolean(failure?.retryable),
    attempts,
  });
}

async function callSarvam({
  operation,
  url,
  apiKey,
  buildRequest,
  readSuccess,
  timeoutMs,
  maxAttempts,
  retryBaseMs,
  retryCeilingMs,
  fetchImpl,
  sleepImpl,
}) {
  if (typeof fetchImpl !== 'function') throw usageError(operation, 'fetchImpl is not callable');
  let failure = null;
  let attempted = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempted = attempt;
    const outcome = await attemptOnce({ url, apiKey, buildRequest, readSuccess, timeoutMs, fetchImpl });
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
  throw exhaustedError({ operation, failure, apiKey, attempts: attempted });
}

async function inputSizeBytes(filePath, operation) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw usageError(operation, 'filePath is not a regular file');
    return stat.size;
  } catch (err) {
    if (err instanceof SarvamError) throw err;
    throw usageError(operation, `filePath is unreadable (${err?.code || err?.name || 'Error'})`);
  }
}

export async function transcribeAudio({
  filePath,
  contentType,
  apiKey,
  model = DEFAULT_STT_MODEL,
  mode = DEFAULT_STT_MODE,
  languageCode = DEFAULT_STT_LANGUAGE,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCeilingMs = DEFAULT_RETRY_CEILING_MS,
  baseUrl = SARVAM_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const operation = 'speech-to-text';
  const key = requiredOption(apiKey, 'apiKey', operation);
  const source = requiredOption(filePath, 'filePath', operation);
  const recordedContentType = requiredOption(contentType, 'contentType', operation);

  const size = await inputSizeBytes(source, operation);
  if (size === 0) throw usageError(operation, 'the recorded audio file is empty');
  if (size > maxInputBytes) {
    throw usageError(operation, `audio is ${size} bytes, above the ${maxInputBytes}-byte upload ceiling`);
  }

  const audio = await fs.readFile(source);
  const uploadName = path.basename(source);

  const payload = await callSarvam({
    operation,
    url: endpointFor(baseUrl, SPEECH_TO_TEXT_PATH),
    apiKey: key,
    buildRequest: () => {
      const form = new FormData();
      form.set('file', new Blob([audio], { type: recordedContentType }), uploadName);
      form.set('model', model);
      form.set('mode', mode);
      if (languageCode) form.set('language_code', languageCode);
      return { headers: {}, body: form };
    },
    readSuccess: (response) => response.json(),
    timeoutMs,
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS),
    retryBaseMs,
    retryCeilingMs,
    fetchImpl,
    sleepImpl,
  });

  const transcript = String(payload?.transcript ?? '').trim();
  if (!transcript) {
    throw new SarvamError(`Sarvam ${operation} returned an empty transcript`, {
      operation,
      status: 200,
      retryable: false,
      attempts: positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS),
    });
  }
  return {
    transcript,
    languageCode: payload?.language_code ? String(payload.language_code) : null,
    requestId: payload?.request_id ? String(payload.request_id) : null,
  };
}

function isInside(baseDirectory, candidate) {
  if (candidate === baseDirectory) return false;
  return candidate.startsWith(baseDirectory + path.sep);
}

async function confinedDestination({ baseDir, outputPath, operation }) {
  const base = path.resolve(baseDir);
  const destination = path.resolve(base, outputPath);
  if (!isInside(base, destination)) {
    throw usageError(operation, 'outputPath resolves outside the permitted base directory');
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o770 });
  const realBase = await fs.realpath(base);
  const realParent = await fs.realpath(path.dirname(destination));
  if (!isInside(realBase, path.join(realParent, path.basename(destination)))) {
    throw usageError(operation, 'outputPath resolves outside the permitted base directory');
  }
  return destination;
}

export function hiddenTemporaryPathFor(destination) {
  const stamp = crypto.randomBytes(6).toString('hex');
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.partial-${process.pid}-${stamp}`,
  );
}

async function writeAtomically({ destination, bytes, operation, apiKey }) {
  const temporary = hiddenTemporaryPathFor(destination);
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o660 });
    await fs.rename(temporary, destination);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new SarvamError(
      redactSecret(`Sarvam ${operation} could not store the audio (${err?.code || err?.name || 'Error'})`, apiKey),
      { operation, status: null, retryable: false, attempts: 0 },
    );
  }
}

export async function synthesizeSpeech({
  text,
  outputPath,
  baseDir,
  apiKey,
  model = DEFAULT_TTS_MODEL,
  speaker = DEFAULT_TTS_SPEAKER,
  languageCode = DEFAULT_TTS_LANGUAGE,
  codec = DEFAULT_TTS_CODEC,
  sampleRate = null,
  maxCharacters = MAX_TTS_CHARACTERS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCeilingMs = DEFAULT_RETRY_CEILING_MS,
  baseUrl = SARVAM_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const operation = 'text-to-speech';
  const key = requiredOption(apiKey, 'apiKey', operation);
  const spoken = requiredOption(text, 'text', operation);
  const requestedPath = requiredOption(outputPath, 'outputPath', operation);
  const root = requiredOption(baseDir, 'baseDir', operation);

  if (spoken.length > maxCharacters) {
    throw usageError(operation, `text is ${spoken.length} characters, above the ${maxCharacters}-character limit`);
  }
  if (!SUPPORTED_TTS_CODECS.includes(codec)) {
    throw usageError(operation, `codec ${codec} is not one the provider documents`);
  }
  const knownSpeakers = MODEL_SPEAKERS[model];
  if (knownSpeakers && !knownSpeakers.includes(speaker)) {
    throw usageError(
      operation,
      `speaker ${speaker} is not available on ${model}; use one of ${knownSpeakers.join(', ')}`,
    );
  }
  const allowedRates = CODEC_SAMPLE_RATES[codec];
  const requestedRate = sampleRate === null ? null : Number(sampleRate);
  if (allowedRates && requestedRate === null) {
    throw usageError(
      operation,
      `codec ${codec} requires an explicit sampleRate, one of ${allowedRates.join(', ')}`,
    );
  }
  if (allowedRates && !allowedRates.includes(requestedRate)) {
    throw usageError(
      operation,
      `codec ${codec} does not support sampleRate ${requestedRate}; use ${allowedRates.join(', ')}`,
    );
  }

  const destination = await confinedDestination({ baseDir: root, outputPath: requestedPath, operation });

  const audio = await callSarvam({
    operation,
    url: endpointFor(baseUrl, TEXT_TO_SPEECH_STREAM_PATH),
    apiKey: key,
    buildRequest: () => ({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: spoken,
        model,
        speaker,
        language_code: languageCode,
        output_audio_codec: codec,
        ...(requestedRate === null ? {} : { speech_sample_rate: requestedRate }),
      }),
    }),
    readSuccess: async (response) => Buffer.from(await response.arrayBuffer()),
    timeoutMs,
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS),
    retryBaseMs,
    retryCeilingMs,
    fetchImpl,
    sleepImpl,
  });

  if (!audio.length) {
    throw new SarvamError(`Sarvam ${operation} returned empty audio`, {
      operation,
      status: 200,
      retryable: false,
      attempts: positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS),
    });
  }

  await writeAtomically({ destination, bytes: audio, operation, apiKey: key });
  return { outputPath: destination, bytes: audio.length, codec };
}
