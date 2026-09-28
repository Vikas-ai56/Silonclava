/** Outbound delivery by convention: anything written to `workspace/outbox/`
 *  is sent. A directory is not a decision the model can skip. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TENANTS_DIR } from './paths.mjs';
import { mediaLinkFor, contentTypeFor } from './media-host.mjs';

export const OUTBOX_DIR = 'outbox';
export const SENT_DIR = path.join(OUTBOX_DIR, 'sent');
/** Twilio takes one media item per message, so each file is its own send. */
export const MAX_FILES_PER_TURN = Number(process.env.ROCKY_OUTBOX_MAX_FILES || 3);
export const UNDELIVERABLE_DIR = path.join(OUTBOX_DIR, 'undeliverable');

/**
 * The same bytes, delivered twice, is a duplicate message to the user — and a
 * rename does not make it a different file. An agent that is unsure whether a
 * send landed writes it again, sometimes under a new name; the outbox used to
 * deliver every copy. Identity is the content, so that is what we compare.
 */
function contentHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Hashes of everything already delivered for this tenant. */
function alreadySent(tenantId) {
  const dir = path.join(workspaceOf(tenantId), SENT_DIR);
  const seen = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return seen; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      seen.set(contentHash(full), name);
    } catch { /* a file mid-move is not a duplicate */ }
  }
  return seen;
}

/** A provider silently drops a type it does not accept, so refuse it here
 *  rather than report a delivery the user never receives. */
export function deliverableBy(channel, file) {
  const allowed = channel?.capabilities?.mediaTypes;
  if (!Array.isArray(allowed)) return { ok: true, type: contentTypeFor(file) };
  const type = contentTypeFor(file);
  return { ok: allowed.includes(type), type };
}

const SKIP_DIRS = new Set(['inbox', 'outbox', 'node_modules', '.git', 'memory']);
/** Workspace configuration, never a deliverable — editing it is not a miss. */
const SKIP_FILES = new Set([
  'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md',
  'BOOTSTRAP.md', 'DREAMS.md', 'TOOLS.md',
]);

function workspaceOf(tenantId) {
  return path.join(TENANTS_DIR, tenantId, 'workspace');
}

/** Instrumentation: how often a turn creates a file that never reaches the user. */
export function snapshotWorkspace(tenantId, dir = workspaceOf(tenantId), depth = 0) {
  const seen = new Map();
  if (depth > 4) return seen;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return seen;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth === 0 && SKIP_DIRS.has(entry.name)) continue;
      for (const [k, v] of snapshotWorkspace(tenantId, full, depth + 1)) seen.set(k, v);
    } else if (entry.isFile()) {
      if (depth === 0 && SKIP_FILES.has(entry.name)) continue;
      try {
        seen.set(full, fs.statSync(full).mtimeMs);
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return seen;
}

export function createdSince(before, after) {
  const out = [];
  for (const [file, mtime] of after) {
    if (!before.has(file) || before.get(file) !== mtime) out.push(file);
  }
  return out;
}

/** Pending files, oldest first. Delivered ones move to `sent/`, which stops a re-send. */
export function pendingOutbox(tenantId) {
  const dir = path.join(workspaceOf(tenantId), OUTBOX_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Deliver one workspace-relative file as a signed link. The path is resolved
 *  against the workspace, so it cannot escape it. */
export async function deliverWorkspaceFile(channel, tenantId, recipient, relPath) {
  const check = deliverableBy(channel, relPath);
  if (!check.ok) {
    const err = new Error(
      `${path.basename(relPath)} is ${check.type}, which this channel does not accept`,
    );
    err.code = 'UNDELIVERABLE_TYPE';
    err.file = path.basename(relPath);
    err.contentType = check.type;
    throw err;
  }
  const { url, expiresAt } = mediaLinkFor(tenantId, relPath);
  const receipt = await channel.sendMedia(recipient, url, { tenantId });
  return { file: path.basename(relPath), expiresAt, providerMessageId: receipt?.providerMessageId || null };
}

/** Runs after the reply is committed, so a send failure cannot cost the answer. */
export async function deliverOutbox(channel, tenantId, recipient, { log = console } = {}) {
  const pending = pendingOutbox(tenantId);
  if (!pending.length) return { delivered: [], failed: [], refused: [], duplicates: [], skipped: 0 };
  if (!recipient || typeof channel?.sendMedia !== 'function') {
    log.warn?.(`[outbox] ${tenantId}: ${pending.length} file(s) waiting but this channel cannot send media`);
    return { delivered: [], failed: [], refused: [], duplicates: [], skipped: pending.length };
  }

  const take = pending.slice(0, MAX_FILES_PER_TURN);
  const delivered = [];
  const failed = [];
  const duplicates = [];
  const sentDir = path.join(workspaceOf(tenantId), SENT_DIR);
  const refused = [];
  // Seeded from what has already gone out, then grown as this drain proceeds,
  // so three copies written in one turn also collapse to one send.
  const seen = alreadySent(tenantId);
  for (const file of take) {
    const name = path.basename(file);

    let hash = null;
    try { hash = contentHash(file); } catch { /* unreadable is handled below */ }
    if (hash && seen.has(hash)) {
      fs.mkdirSync(sentDir, { recursive: true });
      fs.renameSync(file, path.join(sentDir, name));
      duplicates.push({ file: name, sameAs: seen.get(hash) });
      log.log?.(`[outbox] ${tenantId}: ${name} is byte-identical to ${seen.get(hash)} — not sending twice`);
      continue;
    }
    if (hash) seen.set(hash, name);

    const check = deliverableBy(channel, name);
    if (!check.ok) {
      const dir = path.join(workspaceOf(tenantId), UNDELIVERABLE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(file, path.join(dir, name));
      refused.push({ file: name, type: check.type });
      log.warn?.(`[outbox] ${tenantId}: ${name} is ${check.type}, which this channel will not deliver`);
      continue;
    }
    // Move BEFORE minting the link. The provider fetches the URL after it
    // accepts the message, so a file that moves post-send is a 404 by the time
    // it is read — observed as Twilio 63019 with three 404s in the access log.
    fs.mkdirSync(sentDir, { recursive: true });
    const finalPath = path.join(sentDir, name);
    fs.renameSync(file, finalPath);
    try {
      const { url, expiresAt } = mediaLinkFor(tenantId, path.join(SENT_DIR, name));
      const receipt = await channel.sendMedia(recipient, url, { tenantId });
      delivered.push({ file: name, expiresAt, providerMessageId: receipt?.providerMessageId || null });
    } catch (err) {
      fs.renameSync(finalPath, file);
      failed.push({ file: name, error: String(err?.message || err) });
      log.warn?.(`[outbox] ${tenantId}: could not send ${name} — ${err?.message || err}`);
    }
  }
  if (delivered.length) {
    log.log?.(`[outbox] ${tenantId}: sent ${delivered.map((d) => d.file).join(', ')}`);
  }
  return { delivered, failed, refused, duplicates, skipped: Math.max(0, pending.length - take.length) };
}
