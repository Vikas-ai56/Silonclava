import fs from 'node:fs';
import path from 'node:path';
import {
  openTenantDb,
  tenantDbPath,
  tenantDbDir,
  tenantDbSidecarPaths,
  TenantDbError,
} from './open.mjs';
import { migrateTenantDb, LATEST_SCHEMA_VERSION } from './migrations.mjs';
import { encryptValue, decryptValue, assertMasterKey } from '../privacy/aead.mjs';
import { assertPersistable } from '../privacy/policy-guard.mjs';

/**
 * Tenant transcript store (SPEC-phase3c §4, §7).
 *
 * Reuses the existing audited vault AEAD rather than introducing a second
 * crypto path. Bodies are stored as the same envelope shape used elsewhere,
 * bound to the tenant id through the AAD context, so a database file copied
 * into another tenant's directory fails to decrypt instead of leaking.
 */

const TRANSCRIPT_RECORD = 'transcript';

export function encryptBody(tenantId, plaintext) {
  return JSON.stringify(encryptValue(tenantId, TRANSCRIPT_RECORD, plaintext));
}

export function decryptBody(tenantId, cipherText) {
  return decryptValue(tenantId, TRANSCRIPT_RECORD, JSON.parse(cipherText));
}

/** Policy first, then encrypt. A blocked class must never reach ciphertext,
 *  because an encrypted secret is still a stored secret. */
export function sealMessageBody(tenantId, plaintext) {
  assertPersistable(plaintext);
  return encryptBody(tenantId, plaintext);
}

function integrityFailure(db) {
  // quick_check is proportional to database size but skips the full index
  // cross-reference; it is the right check for an open-path guard.
  try {
    const rows = db.pragma('quick_check');
    const result = rows?.[0]?.quick_check;
    return result === 'ok' ? null : String(result || 'unknown integrity failure');
  } catch (err) {
    return String(err?.message || err);
  }
}

function quarantine(tenantId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(tenantDbDir(tenantId), `corrupt-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of Object.values(tenantDbSidecarPaths(tenantId))) {
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, path.basename(file)));
  }
  return dir;
}

/**
 * Opens a tenant database, verifying integrity and applying migrations.
 *
 * Automatic recovery is deliberately narrow: an unreadable or corrupt file is
 * quarantined (never deleted) and replaced with an empty schema so the tenant
 * keeps serving. A *schema* disagreement — checksum mismatch, unknown version,
 * wrong tenant id — is never auto-recovered, because those indicate a code or
 * routing bug where discarding data would destroy evidence.
 *
 * @param {string} tenantId
 * @param {{readonly?: boolean, allowRecovery?: boolean}} [options]
 */
export function openTenantStore(tenantId, options = {}) {
  const readonly = Boolean(options.readonly);
  const allowRecovery = options.allowRecovery !== false && !readonly;
  assertMasterKey();

  let recovered = null;
  let db;
  try {
    db = openTenantDb(tenantId, { readonly });
    const failure = integrityFailure(db);
    if (failure) {
      if (!allowRecovery) throw new TenantDbError(`Database integrity check failed: ${failure}`);
      db.close();
      recovered = { reason: failure, quarantinedTo: quarantine(tenantId) };
      db = openTenantDb(tenantId, { readonly });
    }
  } catch (err) {
    if (!allowRecovery || err?.code === 'ENOENT') throw err;
    // better-sqlite3 surfaces an unreadable file at open time, before any
    // pragma runs, so quick_check never gets the chance to report it.
    if (!/SQLITE_(?:CORRUPT|NOTADB)/.test(String(err?.code || err?.message || ''))) throw err;
    recovered = { reason: String(err.message || err), quarantinedTo: quarantine(tenantId) };
    db = openTenantDb(tenantId, { readonly });
  }

  try {
    if (readonly) {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      if ((row?.v ?? 0) !== LATEST_SCHEMA_VERSION) {
        throw new TenantDbError(
          `Tenant database is at schema ${row?.v ?? 0}, expected ${LATEST_SCHEMA_VERSION}; a readonly connection cannot migrate`,
          { code: 'SCHEMA_STALE' },
        );
      }
    } else {
      migrateTenantDb(db, tenantId);
    }
  } catch (err) {
    db.close();
    throw err;
  }

  return { db, tenantId, readonly, recovered, path: tenantDbPath(tenantId) };
}

/** WAL size is monitored with fs.stat, not the checkpoint return code:
 *  wal_checkpoint(PASSIVE) reports busy: 0 while folding a small fraction of
 *  frames, so a leaked reader grows the WAL invisibly (3.94 MB → 247 MB). */
export function walBytes(tenantId) {
  try {
    return fs.statSync(tenantDbSidecarPaths(tenantId).wal).size;
  } catch {
    return 0;
  }
}
