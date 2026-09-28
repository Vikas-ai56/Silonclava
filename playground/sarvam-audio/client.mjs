import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://api.sarvam.ai';
const MAX_TTS_CHARS = 3500;

function required(value, name) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.aac': 'audio/aac',
    '.amr': 'audio/amr',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
  }[ext] || 'application/octet-stream';
}

async function providerError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = String(body?.error?.message || body?.message || '').slice(0, 180);
  } catch {
    // The status is enough when the provider did not return JSON.
  }
  return new Error(`Sarvam request failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

/**
 * Prototype for Sarvam's synchronous STT endpoint. Production must call this
 * from durable media preprocessing, not while holding the Twilio webhook open.
 */
export async function transcribeFile({
  filePath,
  apiKey,
  languageCode = 'unknown',
  model = 'saaras:v4',
  mode = 'transcribe',
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const key = required(apiKey, 'Sarvam API key');
  const source = required(filePath, 'filePath');
  const bytes = await fs.readFile(source);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: contentTypeFor(source) }), path.basename(source));
  form.set('model', model);
  form.set('mode', mode);
  if (languageCode) form.set('language_code', languageCode);

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/speech-to-text`, {
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: form,
  });
  if (!response.ok) throw await providerError(response);

  const result = await response.json();
  const transcript = String(result?.transcript || '').trim();
  if (!transcript) throw new Error('Sarvam returned an empty transcript');
  return {
    transcript,
    requestId: result.request_id || null,
    languageCode: result.language_code || null,
    languageProbability: result.language_probability ?? null,
  };
}

/**
 * Prototype for Sarvam's binary streaming TTS endpoint. It only creates a
 * file; Rocky's existing outbox remains responsible for delivery.
 */
export async function synthesizeToFile({
  text,
  outputPath,
  apiKey,
  languageCode = 'en-IN',
  speaker = 'shubh',
  model = 'bulbul:v3',
  codec = 'mp3',
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const key = required(apiKey, 'Sarvam API key');
  const spoken = required(text, 'text');
  const destination = required(outputPath, 'outputPath');
  if (spoken.length > MAX_TTS_CHARS) {
    throw new Error(`text exceeds Sarvam's ${MAX_TTS_CHARS}-character streaming limit`);
  }

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/text-to-speech/stream`, {
    method: 'POST',
    headers: {
      'api-subscription-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: spoken,
      language_code: languageCode,
      speaker,
      model,
      output_audio_codec: codec,
    }),
  });
  if (!response.ok) throw await providerError(response);

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('Sarvam returned empty audio');

  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o770 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, audio, { mode: 0o660 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { outputPath: destination, bytes: audio.length, codec };
}
