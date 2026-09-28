import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PLATFORM_DIR } from '../../../paths.mjs';
import {
  readPlatformVaultRecord,
  writePlatformVaultRecord,
} from '../../storage/platform-vault-store.mjs';

const RECORD = 'composio-platform';

function keyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export async function configureComposioPlatform(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key || key.length > 4096) throw new Error('A bounded Composio project key is required on stdin');
  const current = await readPlatformVaultRecord(RECORD);
  const pair = current?.assertionPrivateKey && current?.assertionPublicKey ? null : keyPair();
  const record = {
    apiKey: key,
    assertionPrivateKey: current?.assertionPrivateKey || pair.privateKey,
    assertionPublicKey: current?.assertionPublicKey || pair.publicKey,
    configuredAt: new Date().toISOString(),
  };
  await writePlatformVaultRecord(RECORD, record);
  await materializeComposioRuntimeSecrets(record);
  return { backend: 'composio', configured: true, configuredAt: record.configuredAt };
}

export async function loadComposioPlatformCredentials() {
  const record = await readPlatformVaultRecord(RECORD);
  if (!record?.apiKey || !record?.assertionPrivateKey || !record?.assertionPublicKey) {
    throw new Error('Composio is not configured; run tenant mcp configure --backend composio');
  }
  return record;
}

export function composioRuntimeSecretPaths() {
  const directory = path.join(PLATFORM_DIR, 'runtime-secrets', 'composio');
  return {
    directory,
    apiKey: path.join(directory, 'project-key'),
    publicKey: path.join(directory, 'assertion-public.pem'),
  };
}

export async function materializeComposioRuntimeSecrets(existing = null) {
  const record = existing || await loadComposioPlatformCredentials();
  const paths = composioRuntimeSecretPaths();
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.directory, 0o700);
  // The host directory is private. The files themselves must be readable by
  // the sidecar's non-root UID after a Linux bind mount, whose ownership is
  // not remapped to the image user. They are mounted read-only into exactly
  // that container and are never mounted into a tenant runtime.
  await Promise.all([
    fs.chmod(paths.apiKey, 0o600).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    }),
    fs.chmod(paths.publicKey, 0o600).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    }),
  ]);
  await Promise.all([
    fs.writeFile(paths.apiKey, `${record.apiKey}\n`, { mode: 0o600 }),
    fs.writeFile(paths.publicKey, record.assertionPublicKey, { mode: 0o600 }),
  ]);
  await Promise.all([fs.chmod(paths.apiKey, 0o444), fs.chmod(paths.publicKey, 0o444)]);
  return paths;
}

export async function composioPlatformStatus() {
  try {
    const record = await loadComposioPlatformCredentials();
    return { backend: 'composio', configured: true, configuredAt: record.configuredAt || null };
  } catch {
    return { backend: 'composio', configured: false, configuredAt: null };
  }
}
