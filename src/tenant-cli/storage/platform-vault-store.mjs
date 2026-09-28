import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PLATFORM_DIR } from '../../paths.mjs';
import { withFileLock } from '../../file-lock.mjs';
import {
  decryptVaultValue,
  encryptVaultValue,
  isEncryptedVaultEnvelope,
} from './vault-crypto.mjs';

const PLATFORM_CONTEXT = '_platform';

function recordName(value) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid platform vault record: ${name}`);
  return name;
}

export function platformVaultRecordPath(name) {
  return path.join(PLATFORM_DIR, 'vault', `${recordName(name)}.json`);
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readPlatformVaultRecord(name) {
  const normalized = recordName(name);
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(platformVaultRecordPath(normalized), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!isEncryptedVaultEnvelope(stored)) {
    throw new Error(`Platform vault record is not encrypted: ${normalized}`);
  }
  return decryptVaultValue(PLATFORM_CONTEXT, normalized, stored);
}

export async function writePlatformVaultRecord(name, value) {
  const normalized = recordName(name);
  const file = platformVaultRecordPath(normalized);
  return withFileLock(`${file}.lock`, async () => {
    await atomicWrite(file, encryptVaultValue(PLATFORM_CONTEXT, normalized, value));
    return value;
  });
}

export async function deletePlatformVaultRecord(name) {
  const normalized = recordName(name);
  const file = platformVaultRecordPath(normalized);
  return withFileLock(`${file}.lock`, async () => fs.rm(file, { force: true }));
}
