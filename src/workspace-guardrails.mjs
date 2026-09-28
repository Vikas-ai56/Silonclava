/** Guardrails are written by the control plane, never by the model, and are
 *  verified before a container serves traffic. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TENANTS_DIR, TEMPLATE_WORKSPACE } from './paths.mjs';

export const GUARDRAIL_VERSION = 'v5';
const BLOCKS = [
  {
    file: 'AGENTS.md',
    tag: 'ROCKY-GUARDRAILS',
    legacyTags: ['RIFT-GUARDRAILS'],
    managed: true,
  },
  { file: 'SOUL.md', tag: 'ROCKY-PERSONA', legacyTags: ['RIFT-PERSONA'], managed: false },
];

/** Matches any version so a bump replaces the old block instead of stacking. */
function markers(tag) {
  return {
    start: new RegExp(`<!--\\s*${tag} v\\d+ START[^>]*-->`),
    end: new RegExp(`<!--\\s*${tag} v\\d+ END\\s*-->`),
  };
}

function blockRange(text, tag) {
  const { start, end } = markers(tag);
  const a = text.match(start);
  const b = text.match(end);
  if (!a || !b || a.index > b.index) return null;
  return { start: a.index, end: b.index + b[0].length };
}

function blockFrom(text, tag) {
  const range = blockRange(text, tag);
  return range ? text.slice(range.start, range.end) : null;
}

function renameLegacyMarkers(text, tag, legacyTags) {
  let next = text;
  for (const legacy of legacyTags) {
    next = next.replaceAll(legacy, tag);
  }
  return next;
}

function blockFromAny(text, tags) {
  for (const tag of tags) {
    const block = blockFrom(text, tag);
    if (block) return block;
  }
  return null;
}

function workspaceFile(tenantId, file) {
  return path.join(TENANTS_DIR, tenantId, 'workspace', file);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Replace the managed block in place, or prepend it when the file has none. */
function applyBlock(current, block, tags) {
  const ranges = tags
    .map((tag) => blockRange(current, tag))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  if (!ranges.length) return current ? `${block}\n\n${current}` : `${block}\n`;

  const insertAt = ranges[0].start;
  let withoutBlocks = current;
  for (const range of ranges.toReversed()) {
    withoutBlocks = withoutBlocks.slice(0, range.start) + withoutBlocks.slice(range.end);
  }
  return withoutBlocks.slice(0, insertAt) + block + withoutBlocks.slice(insertAt);
}

/**
 * Bring a tenant's workspace files up to the current guardrail version.
 * Managed blocks are overwritten; unmanaged ones are seeded once so a tenant
 * who wrote their own persona keeps it.
 */
export function ensureWorkspaceGuardrails(tenantId) {
  const changed = [];
  for (const { file, tag, legacyTags, managed } of BLOCKS) {
    const acceptedTags = [tag, ...legacyTags];
    const template = read(path.join(TEMPLATE_WORKSPACE, file));
    const block = blockFrom(template, tag);
    if (!block) throw new Error(`template ${file} has no ${tag} ${GUARDRAIL_VERSION} block`);

    const target = workspaceFile(tenantId, file);
    const original = read(target);
    const current = renameLegacyMarkers(original, tag, legacyTags);
    if (!managed && blockFrom(current, tag)) {
      if (current === original) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, current, { mode: 0o660 });
      changed.push(file);
      continue;
    }
    const next = applyBlock(current, block, acceptedTags);
    if (next === original) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next, { mode: 0o660 });
    changed.push(file);
  }
  return { version: GUARDRAIL_VERSION, changed };
}

/** @returns {{ok: boolean, missing: string[], hash: string|null}} */
export function verifyWorkspaceGuardrails(tenantId) {
  const missing = [];
  const hash = crypto.createHash('sha256');
  for (const { file, tag, legacyTags } of BLOCKS) {
    const block = blockFromAny(read(workspaceFile(tenantId, file)), [tag, ...legacyTags]);
    if (!block) missing.push(`${file}:${tag}`);
    else hash.update(block);
  }
  return {
    ok: missing.length === 0,
    missing,
    hash: missing.length ? null : hash.digest('hex').slice(0, 16),
  };
}
