import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { TENANTS_DIR } from '../../paths.mjs';
import { tenantDir } from '../../tenants.mjs';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function safeSegment(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function tenantPendingDir(tenantId) {
  return path.join(tenantDir(tenantId), 'auth', 'pending');
}

function tenantPendingPath(provider, tenantId, state) {
  return path.join(
    tenantPendingDir(tenantId),
    `${safeSegment(provider, 'OAuth provider')}-${safeSegment(state, 'OAuth state')}.json`,
  );
}

function stateIndexPath(provider, state) {
  return path.join(
    TENANTS_DIR,
    '.auth-state',
    safeSegment(provider, 'OAuth provider'),
    `${safeSegment(state, 'OAuth state')}.json`,
  );
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function removeRecord(provider, tenantId, state, file = tenantPendingPath(provider, tenantId, state)) {
  fs.rmSync(file, { force: true });
  fs.rmSync(stateIndexPath(provider, state), { force: true });
}

function readRow(file, { provider, tenantId = null, state = null, removeInvalid = true } = {}) {
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    const structurallyValid =
      row?.provider === provider &&
      row?.tenantId &&
      row?.state &&
      Number.isFinite(Number(row.createdAt)) &&
      Date.now() - Number(row.createdAt) <= Number(row.ttlMs || DEFAULT_TTL_MS) &&
      (!state || row.state === state);
    if (!structurallyValid) {
      if (removeInvalid && row?.tenantId && row?.state) {
        removeRecord(provider, row.tenantId, row.state, file);
      }
      return null;
    }
    // A caller asking about the wrong tenant must not be able to invalidate the
    // real tenant's pending grant. Binding mismatch is denial, not corruption.
    if (tenantId && row.tenantId !== tenantId) return null;
    return row;
  } catch (err) {
    if (removeInvalid && err?.code !== 'ENOENT') fs.rmSync(file, { force: true });
    return null;
  }
}

function resolvePendingFile(provider, state) {
  const indexFile = stateIndexPath(provider, state);
  let pointer;
  try {
    pointer = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    return null;
  }
  if (pointer?.provider !== provider || pointer?.state !== state || !pointer?.tenantId) {
    fs.rmSync(indexFile, { force: true });
    return null;
  }
  const file = tenantPendingPath(provider, pointer.tenantId, state);
  if (!fs.existsSync(file)) {
    fs.rmSync(indexFile, { force: true });
    return null;
  }
  return { file, tenantId: pointer.tenantId, indexFile };
}

export function clearPendingAuthForTenant(provider, tenantId) {
  const dir = tenantPendingDir(tenantId);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${provider}-`) || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const row = readRow(file, { provider, tenantId, removeInvalid: false });
    fs.rmSync(file, { force: true });
    if (row?.state) fs.rmSync(stateIndexPath(provider, row.state), { force: true });
  }
}

export function createPendingAuth({
  provider,
  tenantId,
  state,
  payload = {},
  ttlMs = DEFAULT_TTL_MS,
}) {
  safeSegment(provider, 'OAuth provider');
  safeSegment(state, 'OAuth state');
  tenantDir(tenantId);
  clearPendingAuthForTenant(provider, tenantId);
  const row = {
    ...payload,
    provider,
    tenantId,
    state,
    createdAt: Date.now(),
    ttlMs,
  };
  const file = tenantPendingPath(provider, tenantId, state);
  const indexFile = stateIndexPath(provider, state);
  atomicWriteJson(file, row);
  try {
    atomicWriteJson(indexFile, { provider, tenantId, state, createdAt: row.createdAt });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  return row;
}

export function peekPendingAuth(provider, state, { tenantId = null } = {}) {
  const resolved = resolvePendingFile(provider, state);
  if (!resolved) return null;
  if (tenantId && resolved.tenantId !== tenantId) return null;
  const row = readRow(resolved.file, { provider, tenantId, state });
  if (!row) fs.rmSync(resolved.indexFile, { force: true });
  return row;
}

export function consumePendingAuth(provider, state, { tenantId = null } = {}) {
  const resolved = resolvePendingFile(provider, state);
  if (!resolved) return null;
  if (tenantId && resolved.tenantId !== tenantId) return null;
  const claimed = `${resolved.file}.claimed-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(resolved.file, claimed);
  } catch {
    return null;
  }
  fs.rmSync(resolved.indexFile, { force: true });
  try {
    return readRow(claimed, { provider, tenantId, state, removeInvalid: false });
  } finally {
    fs.rmSync(claimed, { force: true });
  }
}

export function listPendingAuthForTenant(provider, tenantId) {
  const dir = tenantPendingDir(tenantId);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${provider}-`) && name.endsWith('.json'))
    .map((name) => readRow(path.join(dir, name), { provider, tenantId }))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
}

async function readOptional(file) {
  try {
    return await fsPromises.readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function restoreFile(file, raw) {
  if (raw === null) {
    await fsPromises.rm(file, { force: true });
    return;
  }
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, raw, { mode: 0o600 });
}

export async function rebindPendingAuthForTenantDirectory(
  directory,
  sourceTenantId,
  targetTenantId,
) {
  const pendingDir = path.join(directory, 'auth', 'pending');
  const names = await fsPromises.readdir(pendingDir).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  const backups = [];
  try {
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const file = path.join(pendingDir, name);
      const raw = await fsPromises.readFile(file);
      const row = JSON.parse(raw.toString('utf8'));
      if (row?.tenantId !== sourceTenantId) continue;
      const pointer = stateIndexPath(String(row.provider || ''), String(row.state || ''));
      const pointerRaw = await readOptional(pointer);
      backups.push({ file, raw, pointer, pointerRaw });
      row.tenantId = targetTenantId;
      atomicWriteJson(file, row);
      atomicWriteJson(pointer, {
        provider: row.provider,
        tenantId: targetTenantId,
        state: row.state,
        createdAt: row.createdAt,
      });
    }
  } catch (err) {
    await restorePendingAuthRecords(backups).catch(() => {});
    throw err;
  }
  return backups;
}

export async function restorePendingAuthRecords(backups = []) {
  for (const backup of backups) {
    await restoreFile(backup.file, backup.raw);
    await restoreFile(backup.pointer, backup.pointerRaw);
  }
}
