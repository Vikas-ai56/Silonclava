import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabaseFileReadonly, TenantDbError } from '../tenant-data/open.mjs';
import { schemaVersion } from '../tenant-data/queue-store.mjs';

/**
 * Backup on the writer's own connection (§4). A backup started from a second
 * connection restarts whenever the source is written and may never converge
 * (measured: 202,155 restarts).
 */
export async function backupTenantStore(store, destination) {
  if (store.readonly) throw new TenantDbError('Backup must run on the writer connection');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  await store.db.backup(destination);
  const verify = openDatabaseFileReadonly(destination);
  try {
    const result = verify.pragma('quick_check')?.[0]?.quick_check;
    if (result !== 'ok') throw new TenantDbError(`Backup failed verification: ${result}`);
  } finally {
    verify.close();
  }
  return destination;
}

/**
 * Tenant backup and restore (SPEC-phase3c §8).
 *
 * `openclaw/` is **never raw-archived**: it holds two live WAL SQLite databases
 * belonging to a container that may be running. A filesystem copy of a live WAL
 * database loses recent commits *and still opens clean*, so a restore gate would
 * pass on a corrupt artifact. OpenClaw's own databases are captured with
 * `openclaw backup create --verify`; Rocky's with `db.backup()` on the writer.
 */

const MANIFEST_NAME = 'manifest.json';

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function copyTree(from, to, skip = () => false) {
  if (!fs.existsSync(from)) return [];
  const copied = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src, entry)) continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      copied.push(...copyTree(src, dst, skip));
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      fs.copyFileSync(src, dst);
      copied.push(dst);
    }
  }
  return copied;
}

/**
 * Quiesce, snapshot, and verify. The tenant's database is captured through the
 * writer connection; flat files are copied; `openclaw/` is deliberately
 * excluded and recorded as such in the manifest.
 *
 * @param {object} store  an open writer store for this tenant
 * @param {string} destDir  a fresh directory to write the backup into
 */
export async function createTenantBackup(store, tenantRoot, destDir, meta = {}) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const dbCopy = path.join(destDir, 'data', 'tenant.sqlite');
  await backupTenantStore(store, dbCopy);

  const flat = [];
  for (const rel of ['tenant.json', 'workspace', 'cli-home', 'vault']) {
    const from = path.join(tenantRoot, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(destDir, rel);
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      flat.push(...copyTree(from, to));
    } else {
      fs.copyFileSync(from, to);
      flat.push(to);
    }
  }

  const files = {};
  for (const f of [dbCopy, ...flat]) {
    files[path.relative(destDir, f)] = sha256File(f);
  }

  const manifest = {
    tenantId: store.tenantId,
    createdAt: new Date().toISOString(),
    schemaVersion: schemaVersion(store),
    openclawVersion: meta.openclawVersion ?? null,
    imageDigest: meta.imageDigest ?? null,
    // Recorded so a restore cannot silently assume OpenClaw state is present.
    openclawStateIncluded: false,
    openclawStateNote:
      'openclaw/ is never raw-archived; capture it with `openclaw backup create --verify`',
    files,
  };
  fs.writeFileSync(path.join(destDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Read back and verify every hash, plus the database's own integrity. */
export function verifyTenantBackup(destDir) {
  const manifestPath = path.join(destDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'manifest missing' };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mismatches = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = path.join(destDir, rel);
    if (!fs.existsSync(file)) {
      mismatches.push({ file: rel, reason: 'missing' });
      continue;
    }
    if (sha256File(file) !== expected) mismatches.push({ file: rel, reason: 'hash mismatch' });
  }

  const dbFile = path.join(destDir, 'data', 'tenant.sqlite');
  let integrity = 'missing';
  if (fs.existsSync(dbFile)) {
    const db = openDatabaseFileReadonly(dbFile);
    try {
      integrity = db.pragma('integrity_check')?.[0]?.integrity_check ?? 'unknown';
    } finally {
      db.close();
    }
  }
  return {
    ok: mismatches.length === 0 && integrity === 'ok',
    mismatches,
    integrity,
    manifest,
  };
}

/**
 * Restore into a **staging directory**, never over a live tenant (§8).
 * The caller activates it only after a cold-start verification passes, and
 * keeps the former directory as a rollback point.
 */
export function restoreTenantBackup(destDir, stagingDir, expectedTenantId) {
  const verified = verifyTenantBackup(destDir);
  if (!verified.ok) {
    throw new TenantDbError(
      `Refusing to restore an unverified backup: ${JSON.stringify(verified.mismatches)} integrity=${verified.integrity}`,
      { code: 'BACKUP_UNVERIFIED' },
    );
  }
  if (expectedTenantId && verified.manifest.tenantId !== expectedTenantId) {
    throw new TenantDbError(
      `Backup belongs to ${verified.manifest.tenantId}, not ${expectedTenantId}`,
      { code: 'BACKUP_TENANT_MISMATCH' },
    );
  }
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  copyTree(destDir, stagingDir, (src) => path.basename(src) === MANIFEST_NAME);
  return { stagingDir, manifest: verified.manifest };
}
