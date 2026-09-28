import fs from 'node:fs/promises';
import path from 'node:path';
import {
  synthesizeSpeech, MAX_TTS_CHARACTERS, DEFAULT_TTS_MODEL, DEFAULT_TTS_SPEAKER,
} from './sarvam.mjs';

function apiKey() {
  return String(process.env.SARVAM_API_KEY || '').trim();
}

function configured(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

export function voiceReplyConfigured() {
  return Boolean(apiKey());
}

export function replyIsSpeakable(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return clean.length <= MAX_TTS_CHARACTERS;
}

export function turnHadVoiceNote(attachments) {
  return (attachments || []).some((a) => a?.kind === 'audio' && !a.failed);
}

export async function synthesizeReplyToOutbox({ tenantId, text, outboxDir, turnId }) {
  const key = apiKey();
  if (!key) return null;
  if (!replyIsSpeakable(text)) return null;

  const file = `reply-${turnId}.mp3`;
  await fs.mkdir(outboxDir, { recursive: true, mode: 0o770 });
  const result = await synthesizeSpeech({
    text: String(text).trim(),
    outputPath: path.join(outboxDir, file),
    baseDir: outboxDir,
    apiKey: key,
    languageCode: configured('SARVAM_TTS_LANGUAGE', 'en-IN'),
    speaker: configured('SARVAM_TTS_SPEAKER', DEFAULT_TTS_SPEAKER),
    model: configured('SARVAM_TTS_MODEL', DEFAULT_TTS_MODEL),
  });
  return { file, bytes: result.bytes };
}
