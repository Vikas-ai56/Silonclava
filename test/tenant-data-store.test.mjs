import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantDb, tenantDbPath, tenantDbDir } from '../src/tenant-data/open.mjs';
import { migrateTenantDb, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/tenant-data/migrations.mjs';
import { turnMessageIds } from '../src/tenant-data/queue-store.mjs';
import {
  openTenantStore,
  sealMessageBody,
  decryptBody,
  walBytes,
} from '../src/tenant-data/store.mjs';
import { backupTenantStore } from '../src/state-backup/backup.mjs';
import { classifyForPersistence, assertPersistable } from '../src/privacy/policy-guard.mjs';
import { TENANTS_DIR, ROOT } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_dbt_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}

after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

describe('openTenantDb factory', () => {
  it('applies the durability pragmas SPEC-phase3c §4 requires', () => {
    const db = openTenantDb(freshTenant('pragma'));
    try {
      assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
      // The pragma that silently degrades: it does not persist in the file and
      // better-sqlite3 compiles SQLITE_DEFAULT_WAL_SYNCHRONOUS=1.
      assert.equal(db.pragma('synchronous', { simple: true }), 2);
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(db.pragma('busy_timeout', { simple: true }), 250);
      assert.equal(db.pragma('cache_size', { simple: true }), -2000);
      assert.ok(db.pragma('journal_size_limit', { simple: true }) > 0);
    } finally {
      db.close();
    }
  });

  it('rejects a tenant id that did not come from trusted routing', () => {
    for (const bad of ['../escape', 'a/b', '', 'x'.repeat(65), 'has space']) {
      assert.throws(() => openTenantDb(bad), /Invalid tenant id/);
    }
  });

  it('gives non-gateway callers a handle that physically cannot write', () => {
    const id = freshTenant('ro');
    openTenantDb(id).close();
    const ro = openTenantDb(id, { readonly: true });
    try {
      assert.throws(
        () => ro.exec('CREATE TABLE x (a)'),
        (err) => err.code === 'SQLITE_READONLY' && /readonly database/.test(err.message),
      );
    } finally {
      ro.close();
    }
  });

  it('refuses a readonly open when no database exists', () => {
    assert.throws(() => openTenantDb(freshTenant('missing'), { readonly: true }), /No database/);
  });
});

describe('tenant schema migrations', () => {
  it('is idempotent and records the applied version', () => {
    const id = freshTenant('migrate');
    const db = openTenantDb(id);
    try {
      assert.equal(migrateTenantDb(db, id), LATEST_SCHEMA_VERSION);
      assert.equal(migrateTenantDb(db, id), LATEST_SCHEMA_VERSION);
      const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(rows.map((r) => r.version), MIGRATIONS.map((m) => m.version));
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      for (const t of [
        'messages', 'message_events', 'turns', 'turn_messages',
        'delivery_attempts', 'context_checkpoints', 'tenant_meta', 'schema_migrations',
      ]) {
        assert.ok(tables.includes(t), `missing table ${t}`);
      }
    } finally {
      db.close();
    }
  });

  it('refuses a database belonging to another tenant', () => {
    const owner = freshTenant('owner');
    const other = freshTenant('other');
    const db = openTenantDb(owner);
    try {
      migrateTenantDb(db, owner);
      assert.throws(() => migrateTenantDb(db, other), /belongs to/);
    } finally {
      db.close();
    }
  });

  it('refuses a schema applied from a different definition', () => {
    const id = freshTenant('checksum');
    const db = openTenantDb(id);
    try {
      migrateTenantDb(db, id);
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('tampered', 1);
      assert.throws(() => migrateTenantDb(db, id), /different definition/);
    } finally {
      db.close();
    }
  });

  it('refuses a database newer than this build', () => {
    const id = freshTenant('ahead');
    const db = openTenantDb(id);
    try {
      migrateTenantDb(db, id);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)',
      ).run(999, 'from-the-future', 'x', new Date().toISOString());
      assert.throws(() => migrateTenantDb(db, id), /unknown schema version/);
    } finally {
      db.close();
    }
  });

  it('enforces the uniqueness constraints §4 names', () => {
    const id = freshTenant('unique');
    const store = openTenantStore(id);
    const { db } = store;
    try {
      const insert = db.prepare(`
        INSERT INTO messages
          (conversation_id, sequence, direction, channel, channel_account,
           external_message_id, body_cipher, created_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      const now = new Date().toISOString();
      insert.run('c1', 1, 'inbound', 'twilio', '+100', 'SM1', 'x', now);

      // Inbound dedupe.
      assert.throws(
        () => insert.run('c1', 2, 'inbound', 'twilio', '+100', 'SM1', 'x', now),
        /UNIQUE/,
      );
      // Stable transcript order.
      assert.throws(
        () => insert.run('c1', 1, 'inbound', 'twilio', '+100', 'SM2', 'x', now),
        /UNIQUE/,
      );
      // Outbound rows have no provider id yet; NULLs must not collide.
      insert.run('c1', 3, 'outbound', 'twilio', '+100', null, 'x', now);
      insert.run('c1', 4, 'outbound', 'twilio', '+100', null, 'x', now);

      db.prepare('INSERT INTO turns (request_id, conversation_id, state, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('req-1', 'c1', 'queued', now, now);
      assert.throws(
        () => db.prepare('INSERT INTO turns (request_id, conversation_id, state, created_at, updated_at) VALUES (?,?,?,?,?)')
          .run('req-1', 'c1', 'queued', now, now),
        /UNIQUE/,
      );

      const attempt = db.prepare(
        'INSERT INTO delivery_attempts (outbound_message_id, attempt, status, attempted_at) VALUES (?,?,?,?)',
      );
      attempt.run(3, 1, 'sent', now);
      assert.throws(() => attempt.run(3, 1, 'sent', now), /UNIQUE/);
    } finally {
      db.close();
    }
  });
});

describe('transcript encryption', () => {
  it('stores ciphertext only and round-trips it', () => {
    const id = freshTenant('crypt');
    const store = openTenantStore(id);
    try {
      const secretish = 'Please review the Q3 numbers for Client A';
      const cipher = sealMessageBody(id, secretish);
      assert.doesNotMatch(cipher, /Q3 numbers|Client A/);
      store.db.prepare(`
        INSERT INTO messages (conversation_id, sequence, direction, channel,
          channel_account, body_cipher, created_at)
        VALUES ('c1', 1, 'inbound', 'twilio', '+100', ?, ?)`)
        .run(cipher, new Date().toISOString());

      const raw = fs.readFileSync(tenantDbPath(id));
      assert.equal(raw.includes(Buffer.from('Q3 numbers')), false, 'plaintext found in db file');

      assert.equal(decryptBody(id, cipher), secretish);
    } finally {
      store.db.close();
    }
  });

  it('binds ciphertext to the tenant so a copied database cannot be read', () => {
    const a = freshTenant('bind_a');
    const b = freshTenant('bind_b');
    const cipher = sealMessageBody(a, 'tenant A private message');
    assert.throws(() => decryptBody(b, cipher), /./);
  });

  it('blocks a policy class before it can be encrypted', () => {
    const id = freshTenant('sealblock');
    assert.throws(
      () => sealMessageBody(id, 'here is my key sk-ant-abcdefghijklmnopqrstuvwxyz0123'),
      /PERSISTENCE_POLICY_BLOCKED|persistence policy/,
    );
  });
});

describe('persistence policy guard', () => {
  it('allows ordinary business messages and personal information', () => {
    for (const ok of [
      'Can you summarise the Asana tasks due this week?',
      'My name is Priya and my work email is priya.s@example.com',
      // Luhn-valid and 16 digits, but no grouping and no card vocabulary.
      // Blocking this would drop a legitimate message rather than redact it.
      'The deal size is 4532015112830366 rupees discussed on the call',
      'Call me on +65 6123 4567 at the office',
      'my pin is on the desk in the drawer',
    ]) {
      assert.deepEqual(classifyForPersistence(ok), [], `should allow: ${ok}`);
    }
  });

  it('blocks the classes §7 says must never become transcript', () => {
    const cases = {
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
      api_key: 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv for access',
      token: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K',
      oauth_code: 'https://example.com/cb?code=4%2F0AeanS0abcdefghijklmnop&scope=x',
      password: 'password: hunter2xyz',
      otp: 'OTP: 483920',
      card_pin: 'cvv: 456',
      payment_card: 'card 4532 0151 1283 0366',
    };
    for (const [cls, text] of Object.entries(cases)) {
      const found = classifyForPersistence(text);
      assert.ok(found.includes(cls), `${cls} not detected in: ${text.slice(0, 40)}`);
    }
  });

  it('never echoes the secret in the error it throws', () => {
    const secret = 'sk-ant-api03-SUPERSECRETVALUE0123456789';
    try {
      assertPersistable(`key ${secret}`);
      assert.fail('should have thrown');
    } catch (err) {
      assert.doesNotMatch(String(err.message), /SUPERSECRETVALUE/);
      assert.deepEqual(err.classes, ['api_key']);
    }
  });
});

describe('automatic recovery', () => {
  it('quarantines a corrupt database and keeps the tenant serving', () => {
    const id = freshTenant('corrupt');
    openTenantStore(id).db.close();

    // Overwrite the header so SQLite reports the file is not a database.
    const file = tenantDbPath(id);
    const handle = fs.openSync(file, 'r+');
    fs.writeSync(handle, Buffer.alloc(64, 0xff), 0, 64, 0);
    fs.closeSync(handle);

    const store = openTenantStore(id);
    try {
      assert.ok(store.recovered, 'expected recovery to trigger');
      assert.ok(fs.existsSync(store.recovered.quarantinedTo), 'corrupt file was not preserved');
      // Serving again on a working schema.
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        0,
      );
    } finally {
      store.db.close();
    }
  });

  it('does not auto-recover a schema disagreement', () => {
    const id = freshTenant('noautofix');
    const first = openTenantStore(id);
    first.db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered');
    first.db.close();
    assert.throws(() => openTenantStore(id), /different definition/);
    // The data is still there, not discarded.
    assert.ok(fs.existsSync(tenantDbPath(id)));
  });
});

describe('backup on the writer connection', () => {
  it('produces a verified backup and refuses a readonly connection', async () => {
    const id = freshTenant('backup');
    const store = openTenantStore(id);
    const dest = path.join(tenantDbDir(id), 'backup', 'tenant.sqlite');
    try {
      store.db.prepare(`
        INSERT INTO messages (conversation_id, sequence, direction, channel,
          channel_account, body_cipher, created_at)
        VALUES ('c1', 1, 'inbound', 'twilio', '+100', ?, ?)`)
        .run(sealMessageBody(id, 'hello'), new Date().toISOString());

      await backupTenantStore(store, dest);
      assert.ok(fs.existsSync(dest));
      assert.ok(walBytes(id) >= 0);
    } finally {
      store.db.close();
    }

    const ro = openTenantStore(id, { readonly: true });
    try {
      await assert.rejects(
        backupTenantStore(ro, path.join(tenantDbDir(id), 'backup', 'no.sqlite')),
        /writer connection/,
      );
    } finally {
      ro.db.close();
    }
  });
});

describe('openTenantDb is the only connection path', () => {
  /**
   * SPEC-phase3c §4 bans bare `new Database()`. The repo has no lint
   * toolchain (the only eslint dependency is a vendored no-op stub for a
   * Baileys peer requirement), so the ban is enforced here instead, where it
   * actually runs on every `npm test`.
   */
  it('has no direct better-sqlite3 construction outside the factory', () => {
    const allowed = path.join('src', 'tenant-data', 'open.mjs');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.mjs')) {
          const rel = path.relative(ROOT, full);
          if (rel === allowed) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/new Database\s*\(/.test(text) || /from 'better-sqlite3'/.test(text)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepEqual(offenders, [], `open a tenant database through openTenantDb(): ${offenders}`);
  });
});

describe('migration 002 — turn state machine', () => {
  it('migrates a v1 database in place, mapping states and keeping turn_messages', () => {
    const id = freshTenant('mig002');
    // Build a database at schema 1 only, as a tenant provisioned before 002 has.
    const db = openTenantDb(id);
    const only001 = MIGRATIONS.filter((m) => m.version === 1);
    const saved = MIGRATIONS.splice(0, MIGRATIONS.length, ...only001);
    let turnIds;
    try {
      migrateTenantDb(db, id);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO messages (conversation_id, sequence, direction, channel,
        channel_account, body_cipher, created_at) VALUES ('c1',1,'inbound','twilio','+1','x',?)`).run(now);
      const mk = db.prepare(
        'INSERT INTO turns (request_id, conversation_id, state, created_at, updated_at) VALUES (?,?,?,?,?)',
      );
      const running = Number(mk.run('r-run', 'c1', 'running', now, now).lastInsertRowid);
      const delivered = Number(mk.run('r-del', 'c1', 'delivered', now, now).lastInsertRowid);
      const queued = Number(mk.run('r-que', 'c1', 'queued', now, now).lastInsertRowid);
      db.prepare('INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?,1,1)').run(running);
      turnIds = { running, delivered, queued };
    } finally {
      MIGRATIONS.splice(0, MIGRATIONS.length, ...saved);
      db.close();
    }

    // Reopening applies 002.
    const store = openTenantStore(id);
    try {
      const byId = new Map(
        store.db.prepare('SELECT id, state, route FROM turns').all().map((r) => [r.id, r]),
      );
      assert.equal(byId.get(turnIds.running).state, 'claimed');
      assert.equal(byId.get(turnIds.delivered).state, 'completed');
      assert.equal(byId.get(turnIds.queued).state, 'queued', 'untouched states must survive');
      assert.equal(byId.get(turnIds.running).route, 'openclaw', 'envelope route defaults');

      // The rebuild must not orphan turn_messages.
      assert.deepEqual(turnMessageIds(store, turnIds.running), [1]);

      // The new states are now accepted, and an invented one still is not.
      const upd = store.db.prepare('UPDATE turns SET state = ? WHERE id = ?');
      for (const s of ['response_saved', 'send_started', 'delivery_unknown']) {
        upd.run(s, turnIds.queued);
      }
      assert.throws(() => upd.run('running', turnIds.queued), /CHECK/);
      assert.throws(() => upd.run('not_a_state', turnIds.queued), /CHECK/);
    } finally {
      store.db.close();
    }
  });
});
