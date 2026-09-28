import fs from 'node:fs';
import path from 'node:path';
import { decryptValue, encryptValue, envelopeVersion, isEncryptedEnvelope } from './aead.mjs';

export function migrateVaultDirectory(directory, tenantId, { dryRun = false } = {}) {
  const counts = { scanned: 0, migrated: 0, alreadyV2: 0, skipped: [] };
  if (!fs.existsSync(directory)) return counts;

  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue;
    const record = entry.slice(0, -'.json'.length);
    const file = path.join(directory, entry);
    counts.scanned += 1;

    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      counts.skipped.push(`${entry}: unreadable (${err?.message || err})`);
      continue;
    }
    if (!isEncryptedEnvelope(stored)) {
      counts.skipped.push(`${entry}: not an envelope`);
      continue;
    }
    if (envelopeVersion(stored) !== 1) {
      counts.alreadyV2 += 1;
      continue;
    }

    const plaintext = decryptValue(tenantId, record, stored);
    const next = encryptValue(tenantId, record, plaintext);
    if (!dryRun) {
      const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
      fs.chmodSync(file, 0o600);
    }
    counts.migrated += 1;
  }
  return counts;
}
