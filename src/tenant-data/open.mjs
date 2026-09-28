import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TENANTS_DIR } from '../paths.mjs';

/**
 * The single entry point to every tenant database connection
 * (SPEC-phase3c §4). Bare `new Database()` is banned: `synchronous` does not
 * persist in the file and better-sqlite3 compiles
 * SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so any connection that skips the pragma
 * silently commits at NORMAL and loses the power-loss durability §4 requires.
 */

// journal_size_limit is explicit rather than default (-1 = never truncate).
// A leaked reader was measured growing a WAL from 3.94 MB to 247 MB.
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const CACHE_SIZE_KIB = -2000; // negative = KiB, not pages. Default 16 MB/conn.
const BUSY_TIMEOUT_MS = 250;

export class TenantDbError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'TenantDbError';
    if (options.code) this.code = options.code;
  }
}

/** Tenant IDs come from trusted server routing only — never a channel, model,
 *  MCP, or CLI payload (§4). This is the last line of defence, not the first. */
function assertTenantId(tenantId) {
  const id = String(tenantId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new TenantDbError(`Invalid tenant id for database path: ${id || '<empty>'}`);
  }
  return id;
}

export function tenantDbDir(tenantId) {
  return path.join(TENANTS_DIR, assertTenantId(tenantId), 'data');
}

export function tenantDbPath(tenantId) {
  return path.join(tenantDbDir(tenantId), 'tenant.sqlite');
}

export function tenantDbSidecarPaths(tenantId) {
  const file = tenantDbPath(tenantId);
  return { db: file, wal: `${file}-wal`, shm: `${file}-shm` };
}

/**
 * Writes come from the gateway process only. `bin/tenant.mjs` is a separate OS
 * process; giving it a write handle would make two writers permanent and break
 * backup convergence, WAL checkpointing, and the fencing generation. Operator
 * mutations go through the gateway; operator *reads* open readonly here.
 */
function applyPragmas(db, { readonly }) {
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma(`cache_size = ${CACHE_SIZE_KIB}`);
  db.pragma('foreign_keys = ON');

  if (!readonly) {
    // journal_mode is persistent; setting it on a readonly connection fails.
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (String(mode).toLowerCase() !== 'wal') {
      throw new TenantDbError(`Could not enable WAL (journal_mode=${mode})`);
    }
    db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
    db.pragma('synchronous = FULL');

    // Assert rather than trust: this is the pragma that silently degrades.
    const synchronous = db.pragma('synchronous', { simple: true });
    if (synchronous !== 2) {
      throw new TenantDbError(
        `synchronous must be FULL (2) but is ${synchronous}; refusing to serve a connection that commits without durability`,
      );
    }
  }
  return db;
}

/**
 * @param {string} tenantId
 * @param {{readonly?: boolean, create?: boolean}} [options]
 */
export function openTenantDb(tenantId, options = {}) {
  const readonly = Boolean(options.readonly);
  const create = options.create !== false && !readonly;
  const file = tenantDbPath(tenantId);

  if (create) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(file)) {
    throw new TenantDbError(`No database for tenant ${tenantId}`, { code: 'ENOENT' });
  }

  const db = new Database(file, { readonly, fileMustExist: !create });
  try {
    return applyPragmas(db, { readonly });
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Opens an arbitrary SQLite file read-only for verification (backup checks).
 * Not a tenant path: it takes a filename, so it deliberately bypasses tenant
 * id resolution. It still routes through this module so `new Database()` stays
 * banned everywhere else.
 */
export function openDatabaseFileReadonly(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return applyPragmas(db, { readonly: true });
  } catch (err) {
    db.close();
    throw err;
  }
}
