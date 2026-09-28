import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { tenantDir } from './tenants.mjs';

export const INBOUND_MEDIA_DIR = 'inbox';
const MAX_BYTES = Number(process.env.ROCKY_INBOUND_MEDIA_MAX_BYTES || 16 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(process.env.ROCKY_INBOUND_MEDIA_TIMEOUT_MS || 20_000);

const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/msword': '.doc',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
};

/**
 * A transcript is encrypted text. It cannot hold bytes, and pretending
 * otherwise makes the ledger lie about what was said — so each kind of media
 * gets the representation that is actually true for it:
 *
 *   image    the caption, plus a marker. The picture itself is described by the
 *            agent once it has seen it; we never invent a caption.
 *   audio    the transcript, as the message body. This is the one case where
 *            the text genuinely is what the user said, so it should match a
 *            search for those words.
 *   document the caption plus name and type. Extracted text, if any, is
 *            recorded as extraction — not as the user's words.
 *   video    caption plus marker only.
 */
export function mediaKind(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'document';
}

export function extensionFor(contentType) {
  return EXT[String(contentType || '').toLowerCase()] || '';
}

/**
 * Build the text that goes into the durable transcript for one message.
 * `transcript` is supplied only for audio that was actually transcribed.
 */
export function transcriptBodyFor({ caption = '', attachments = [] }) {
  const parts = [];
  const text = String(caption || '').trim();

  for (const a of attachments) {
    if (a.kind === 'audio' && a.transcript) {
      // The words are the message. The marker records where they came from so a
      // reader knows this was spoken, not typed.
      parts.push(`${a.transcript.trim()}\n[voice note: ${a.file}]`);
    } else if (a.kind === 'audio') {
      parts.push(`[voice note: ${a.file} — not transcribed]`);
    } else if (a.kind === 'image') {
      parts.push(`[image: ${a.file}]`);
    } else if (a.kind === 'video') {
      parts.push(`[video: ${a.file}]`);
    } else {
      parts.push(`[document: ${a.file}, ${a.contentType}, ${a.bytes} bytes]`);
    }
  }

  if (text) parts.unshift(text);
  return parts.join('\n').trim();
}

/**
 * What the agent is told, beyond the transcript body: where the files actually
 * are, so it can open an image or read a document.
 */
export function attachmentPreamble(attachments, containerWorkspace = '/tenant/workspace') {
  if (!attachments?.length) return '';
  const lines = attachments.map((a) => {
    const where = `${containerWorkspace}/${INBOUND_MEDIA_DIR}/${a.file}`;
    if (a.kind === 'image') return `- image at ${where} — open it and describe what is actually there`;
    if (a.kind === 'audio') {
      if (a.transcript) return `- voice note at ${where}, already transcribed above`;
      if (a.transcriptFailure === 'too-long') {
        return `- voice note at ${where} — too long to transcribe (the limit is 30 seconds). `
          + 'Tell them that plainly and ask for a shorter one or the text, and do not guess '
          + 'at what it said';
      }
      return `- voice note at ${where} — transcription unavailable, say so rather than guessing`;
    }
    if (a.kind === 'video') return `- video at ${where} — you cannot watch it; acknowledge it only`;
    return `- document at ${where} (${a.contentType})`;
  });
  return `The user attached ${attachments.length} file(s):\n${lines.join('\n')}\n\n---\n`;
}

function safeName(contentType, index) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${stamp}-${index}-${rand}${extensionFor(contentType)}`;
}

/**
 * Fetch one provider media URL into the tenant's own inbox directory.
 *
 * Fetched on receipt, never stored as a URL: Twilio's link is signed for ~4
 * hours and Meta's for 5 minutes, so any code that keeps the URL and fetches it
 * later breaks on a provider switch — and on Meta, inbound media is retained
 * for only 7 days at the provider.
 */
export async function fetchInboundMedia(tenantId, { url, contentType, index = 0, auth = null }) {
  const dir = path.join(tenantDir(tenantId), 'workspace', INBOUND_MEDIA_DIR);
  await fsPromises.mkdir(dir, { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: auth ? { Authorization: auth } : undefined,
    });
    if (!res.ok) throw new Error(`provider returned HTTP ${res.status}`);

    const declared = res.headers.get('content-type') || contentType || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error(`file is ${buf.byteLength} bytes, over the limit`);

    const file = safeName(declared.split(';')[0].trim(), index);
    await fsPromises.writeFile(path.join(dir, file), buf, { mode: 0o660 });

    return {
      file,
      kind: mediaKind(declared),
      contentType: declared.split(';')[0].trim(),
      bytes: buf.byteLength,
      path: path.join(dir, file),
    };
  } finally {
    clearTimeout(timer);
  }
}
