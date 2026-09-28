import { transcribeAudio as transcribeWithSarvam } from './speech/sarvam.mjs';

let warned = false;
let warnedMissingContentType = false;

function configuredKey() {
  return String(process.env.SARVAM_API_KEY || '').trim();
}

function configuredOverride(name) {
  const value = String(process.env[name] || '').trim();
  return value || undefined;
}

function configuredMilliseconds(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function recordedMedia(file) {
  if (!file || typeof file !== 'object') return null;
  const filePath = typeof file.path === 'string' ? file.path.trim() : '';
  const contentType = typeof file.contentType === 'string' ? file.contentType.trim() : '';
  return filePath && contentType ? { filePath, contentType } : null;
}

/** @returns {Promise<string|null>} the transcript, or null when unavailable. */
export async function transcribeAudio(tenantId, file) {
  const apiKey = configuredKey();
  if (!apiKey) {
    if (!warned) {
      warned = true;
      console.warn('[transcribe] no provider configured — voice notes are recorded untranscribed');
    }
    return null;
  }

  const media = recordedMedia(file);
  if (!media) {
    if (!warnedMissingContentType) {
      warnedMissingContentType = true;
      console.warn('[transcribe] caller supplied no recorded media record — voice notes are recorded untranscribed');
    }
    return null;
  }

  const { transcript } = await transcribeWithSarvam({
    filePath: media.filePath,
    contentType: media.contentType,
    apiKey,
    model: configuredOverride('SARVAM_STT_MODEL'),
    mode: configuredOverride('SARVAM_STT_MODE'),
    languageCode: configuredOverride('SARVAM_STT_LANGUAGE'),
    timeoutMs: configuredMilliseconds('SARVAM_TIMEOUT_MS'),
  });
  return transcript;
}
