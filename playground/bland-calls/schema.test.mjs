import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function call(overrides = {}) {
  return {
    id: 'local-call-1',
    providerCallId: 'provider-call-1',
    requestKey: 'request-1',
    callbackRefHash: 'callback-hash-1',
    destinationCipher: 'encrypted-phone',
    taskCipher: 'encrypted-task',
    status: 'submitted',
    requestedAt: '2026-09-25T09:00:00Z',
    updatedAt: '2026-09-25T09:00:00Z',
    ...overrides,
  };
}

function insertCall(db, row) {
  db.prepare(`
    INSERT INTO voice_calls (
      id, provider_call_id, request_key, callback_ref_hash,
      destination_cipher, task_cipher, status, requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.providerCallId,
    row.requestKey,
    row.callbackRefHash,
    row.destinationCipher,
    row.taskCipher,
    row.status,
    row.requestedAt,
    row.updatedAt,
  );
}

describe('Bland tenant-storage reference schema', () => {
  it('deduplicates provider calls, requests and webhook events', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    insertCall(db, call());

    assert.throws(() => insertCall(db, call({ id: 'local-call-2', requestKey: 'request-2', callbackRefHash: 'callback-hash-2' })), /UNIQUE/);
    db.prepare(`
      INSERT INTO voice_call_events
        (call_id, fingerprint, status, payload_cipher, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('local-call-1', 'event-hash-1', 'completed', 'encrypted-payload', '2026-09-25T10:00:00Z');
    assert.throws(() => db.prepare(`
      INSERT INTO voice_call_events
        (call_id, fingerprint, status, payload_cipher, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('local-call-1', 'event-hash-1', 'completed', 'encrypted-payload', '2026-09-25T10:00:01Z'), /UNIQUE/);

    db.close();
  });

  it('keeps call data tenant-local and removes events with their call', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    insertCall(db, call());
    db.prepare(`
      INSERT INTO voice_call_events
        (call_id, fingerprint, status, payload_cipher, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('local-call-1', 'event-hash-1', 'queued', 'encrypted-payload', '2026-09-25T09:01:00Z');

    db.prepare('DELETE FROM voice_calls WHERE id = ?').run('local-call-1');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM voice_call_events').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('voice_calls') WHERE name = 'tenant_id'").get().count, 0);
    db.close();
  });
});
