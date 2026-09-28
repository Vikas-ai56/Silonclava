import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { tenantDir } from './tenants.mjs';
import { PUBLIC_BASE_URL, API_TOKEN } from './config.mjs';

export const MEDIA_PATH_PREFIX = '/files';
export const MEDIA_TTL_MS = Number(process.env.ROCKY_MEDIA_TTL_MS || 60 * 60 * 1000);
const MAX_BYTES = Number(process.env.ROCKY_MEDIA_MAX_BYTES || 16 * 1024 * 1024);

/**
 * Twilio does not accept uploaded bytes for WhatsApp: you give it a URL and
 * *Twilio's servers fetch it*, so anything the agent sends must be reachable
 * from the public internet. That is a liability, not a feature — these are
 * tenant documents. So a link is
 *
 *   - signed, so it cannot be guessed or enumerated,
 *   - scoped to one file of one tenant, named inside the signature,
 *   - short-lived, because Twilio fetches within seconds.
 *
 * Meta's Cloud API takes an upload and needs none of this; when the provider
 * changes, this whole surface should go away rather than be ported.
 */
const MIME = {
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  // text — anything human-readable is served as text/plain so the provider
  // renders it instead of rejecting an octet-stream it cannot classify
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.markdown': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.html': 'text/html',
  // images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  // audio / video
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.3gp': 'video/3gpp',
  // archives
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};

export function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function signingKey() {
  const secret = process.env.ROCKY_MEDIA_SIGNING_KEY || API_TOKEN;
  if (!secret) throw new Error('Media links need ROCKY_MEDIA_SIGNING_KEY or ROCKY_API_TOKEN');
  return secret;
}

function sign(tenantId, relPath, expiresAt) {
  return crypto
    .createHmac('sha256', signingKey())
    .update(`${tenantId}\n${relPath}\n${expiresAt}`)
    .digest('base64url');
}

/**
 * Resolve a caller-supplied path inside the tenant's workspace, refusing
 * anything that escapes it. The agent chooses this string, so it is untrusted.
 */
export function resolveWorkspaceFile(tenantId, relPath) {
  const workspace = path.resolve(tenantDir(tenantId), 'workspace');
  const target = path.resolve(workspace, String(relPath || '').replace(/^\/+/, ''));
  if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) {
    throw new Error('Path is outside the workspace');
  }
  return { workspace, target, relPath: path.relative(workspace, target) };
}

export function mediaLinkFor(tenantId, relPath, { ttlMs = MEDIA_TTL_MS } = {}) {
  const { relPath: clean } = resolveWorkspaceFile(tenantId, relPath);
  const expiresAt = Date.now() + ttlMs;
  const sig = sign(tenantId, clean, expiresAt);
  const base = String(PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = `${base}${MEDIA_PATH_PREFIX}/${encodeURIComponent(tenantId)}/${clean
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?e=${expiresAt}&s=${sig}`;
  return { url, expiresAt, relPath: clean };
}

/**
 * @returns {Promise<{status:number, headers?:object, body?:Buffer|string}>}
 */
export async function serveMedia(pathname, searchParams) {
  const rest = pathname.slice(MEDIA_PATH_PREFIX.length + 1);
  const [rawTenant, ...rawParts] = rest.split('/');
  const tenantId = decodeURIComponent(rawTenant || '');
  const relPath = rawParts.map(decodeURIComponent).join('/');
  const expiresAt = Number(searchParams.get('e') || 0);
  const presented = String(searchParams.get('s') || '');

  if (!tenantId || !relPath || !Number.isFinite(expiresAt)) {
    return { status: 404, body: 'not found' };
  }
  if (Date.now() > expiresAt) return { status: 410, body: 'link expired' };

  let resolved;
  try {
    resolved = resolveWorkspaceFile(tenantId, relPath);
  } catch {
    return { status: 404, body: 'not found' };
  }

  const expected = sign(tenantId, resolved.relPath, expiresAt);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { status: 403, body: 'bad signature' };
  }

  let stat;
  try {
    stat = await fsPromises.stat(resolved.target);
  } catch {
    return { status: 404, body: 'not found' };
  }
  if (!stat.isFile()) return { status: 404, body: 'not found' };
  if (stat.size > MAX_BYTES) return { status: 413, body: 'file too large to send' };

  return {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(resolved.target),
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${path.basename(resolved.target)}"`,
    },
    body: fs.createReadStream(resolved.target),
  };
}
