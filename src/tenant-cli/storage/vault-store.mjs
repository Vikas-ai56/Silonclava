import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../file-lock.mjs';
import { tenantDir } from '../../tenants.mjs';
import {
  decryptVaultValue,
  encryptVaultValue,
  isEncryptedVaultEnvelope,
} from './vault-crypto.mjs';

function validateRecordName(recordName) {
  const name = String(recordName || '');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid vault record: ${name}`);
  return name;
}

export function vaultRecordPath(tenantId, recordName) {
  return path.join(tenantDir(tenantId), 'vault', `${validateRecordName(recordName)}.json`);
}

async function atomicWriteEnvelope(file, envelope) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function readRecordFile(tenantId, recordName, { migratePlaintext = true } = {}) {
  const file = vaultRecordPath(tenantId, recordName);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`Cannot read vault record ${recordName}: ${err?.message || err}`);
  }
  if (isEncryptedVaultEnvelope(parsed)) {
    return decryptVaultValue(tenantId, recordName, parsed);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid legacy vault record: ${recordName}`);
  }
  if (!migratePlaintext) return parsed;

  // Compatibility is deliberately one-way: a successful legacy read is
  // immediately replaced atomically with an authenticated encrypted envelope.
  await atomicWriteEnvelope(file, encryptVaultValue(tenantId, recordName, parsed));
  return parsed;
}

export async function readVaultRecord(tenantId, recordName, { migratePlaintext = true } = {}) {
  return readRecordFile(tenantId, validateRecordName(recordName), { migratePlaintext });
}

export async function writeVaultRecord(tenantId, recordName, value) {
  const name = validateRecordName(recordName);
  const file = vaultRecordPath(tenantId, name);
  await atomicWriteEnvelope(file, encryptVaultValue(tenantId, name, value));
  return value;
}

export async function updateVaultRecord(tenantId, recordName, update, { waitMs = 5_000 } = {}) {
  const name = validateRecordName(recordName);
  const file = vaultRecordPath(tenantId, name);
  return withFileLock(`${file}.lock`, async () => {
    const current = await readRecordFile(tenantId, name);
    const next = await update(current);
    if (next == null) {
      await fs.rm(file, { force: true });
      return null;
    }
    await atomicWriteEnvelope(file, encryptVaultValue(tenantId, name, next));
    return next;
  }, { waitMs });
}

export async function deleteVaultRecord(tenantId, recordName, { waitMs = 5_000 } = {}) {
  const name = validateRecordName(recordName);
  const file = vaultRecordPath(tenantId, name);
  return withFileLock(`${file}.lock`, async () => {
    const existed = await fs.access(file).then(() => true, () => false);
    await fs.rm(file, { force: true });
    return existed;
  }, { waitMs });
}

export async function listVaultRecords(tenantId) {
  const dir = path.join(tenantDir(tenantId), 'vault');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .sort();
}

export async function verifyVaultRecords(tenantId) {
  const records = [];
  for (const recordName of await listVaultRecords(tenantId)) {
    try {
      const value = await readVaultRecord(tenantId, recordName, { migratePlaintext: false });
      records.push({ recordName, readable: true, fields: Object.keys(value || {}).sort() });
    } catch (err) {
      records.push({ recordName, readable: false, error: String(err?.message || err) });
    }
  }
  return { ok: records.every((entry) => entry.readable), records };
}

async function atomicWriteJson(file, value) {
  await atomicWriteEnvelope(file, value);
}

export async function rebindTenantVaultRecords(
  directory,
  sourceTenantId,
  targetTenantId,
  { exclude = [] } = {},
) {
  const vaultDir = path.join(directory, 'vault');
  const ignored = new Set(exclude);
  const entries = await fs.readdir(vaultDir, { withFileTypes: true }).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  const backups = [];
  try {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const recordName = entry.name.slice(0, -'.json'.length);
      if (ignored.has(recordName)) continue;
      validateRecordName(recordName);
      const file = path.join(vaultDir, entry.name);
      const raw = await fs.readFile(file);
      const stored = JSON.parse(raw.toString('utf8'));
      const value = isEncryptedVaultEnvelope(stored)
        ? decryptVaultValue(sourceTenantId, recordName, stored)
        : stored;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid vault record during tenant migration: ${entry.name}`);
      }
      backups.push({ file, raw });
      await atomicWriteJson(file, encryptVaultValue(targetTenantId, recordName, value));
    }
  } catch (err) {
    await restoreVaultRecords(backups).catch(() => {});
    throw err;
  }
  return backups;
}

export async function restoreVaultRecords(backups = []) {
  for (const backup of backups) {
    if (backup.raw === null) await fs.rm(backup.file, { force: true });
    else {
      await fs.mkdir(path.dirname(backup.file), { recursive: true });
      await fs.writeFile(backup.file, backup.raw, { mode: 0o600 });
    }
  }
}
