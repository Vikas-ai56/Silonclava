import { decryptValue, encryptValue, envelopeVersion } from '../privacy/aead.mjs';

const ENCRYPTED_COLUMNS = [
  { table: 'messages', column: 'body_cipher', record: 'transcript' },
  { table: 'context_checkpoints', column: 'summary_cipher', record: 'transcript' },
];

function reseal(tenantId, record, raw) {
  const envelope = JSON.parse(raw);
  if (envelopeVersion(envelope) !== 1) return null;
  return JSON.stringify(encryptValue(tenantId, record, decryptValue(tenantId, record, envelope)));
}

export function migrateStoreEnvelopes(store, { dryRun = false } = {}) {
  const { db, tenantId } = store;
  const counts = { scanned: 0, migrated: 0, alreadyV2: 0 };

  db.transaction(() => {
    for (const { table, column, record } of ENCRYPTED_COLUMNS) {
      const rows = db.prepare(`SELECT id, ${column} AS cipher FROM ${table}`).all();
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        counts.scanned += 1;
        const next = reseal(tenantId, record, row.cipher);
        if (next === null) {
          counts.alreadyV2 += 1;
          continue;
        }
        if (!dryRun) update.run(next, row.id);
        counts.migrated += 1;
      }
    }
  })();
  return counts;
}
