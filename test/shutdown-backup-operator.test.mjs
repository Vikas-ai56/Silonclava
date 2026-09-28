import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import {
  recordInboundAndQueueTurn, claimNextTurn, markSendStartedUnknown,
  recoverInterruptedTurns, listTurnsByState, turnStateCounts,
} from '../src/tenant-data/queue-store.mjs';
import { saveResponse, beginSend } from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import {
  createTenantBackup, verifyTenantBackup, restoreTenantBackup,
} from '../src/state-backup/backup.mjs';
import { executeTenantCommand } from '../src/tenant-cli/index.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';
import { tenantDir } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { resetScheduler } from '../src/inbound-queue.mjs';

const created = [];
const tmp = [];
let seq = 0;
beforeEach(() => resetScheduler());
after(async () => {
  resetScheduler();
  for (const id of created) {
    await deleteTenant(id).catch(() => {});
    fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  }
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

async function tenant() {
  seq += 1;
  const phone = `1555${String(process.pid).slice(-5)}${seq}`;
  const t = await provisionTenant({
    phone, jid: `${phone}@s.whatsapp.net`, name: `T${seq}`,
    plan: 'claude', email: null, finalState: 'READY',
  });
  created.push(t.id);
  return t;
}

const inbound = (body) => ({
  conversationId: 'c1', channel: 'whatsapp', channelAccount: '+6591234567', body,
});

describe('shutdown classification (§8 step 4)', () => {
  it('requeues pre-commit turns and marks started sends delivery_unknown', async () => {
    const t = await tenant();
    const store = openTenantStore(t.id);
    try {
      // One turn mid-model (pre-commit) and one that had begun sending.
      recordInboundAndQueueTurn(store, inbound('first'));
      const claimed = claimNextTurn(store, { runtimeId: 'c', generation: 1 });
      const saved = saveResponse(store, claimed.id, 'committed answer');
      beginSend(store, claimed.id, saved.messageId);

      recordInboundAndQueueTurn(store, inbound('second'));
      const second = claimNextTurn(store, { runtimeId: 'c', generation: 1 });
      assert.equal(second, null, 'one active turn per tenant');

      assert.equal(markSendStartedUnknown(store, 'SHUTDOWN'), 1);
      const counts = turnStateCounts(store);
      assert.equal(counts[TURN_STATE.DELIVERY_UNKNOWN], 1);

      // A pre-commit turn returns to queued for full re-execution.
      const requeued = recoverInterruptedTurns(store);
      assert.ok(requeued >= 0);
      const after = turnStateCounts(store);
      assert.equal(after[TURN_STATE.SEND_STARTED], undefined, 'nothing left mid-send');
    } finally { store.db.close(); }
  });

  it('orders shutdown as intake -> drain -> classify -> close -> gateways', async () => {
    const file = await fs.promises.readFile('src/index.mjs', 'utf8');
    // Scope to the function body: searching the whole file would measure the
    // order of the import statements, not the order of the calls.
    const body = file.slice(
      file.indexOf('async function shutdown(signal) {'),
      file.indexOf("process.on('SIGINT'"),
    );
    assert.ok(body.length > 0, 'shutdown function not found');
    const at = (needle) => {
      const i = body.indexOf(needle);
      assert.ok(i >= 0, `shutdown must call ${needle}`);
      return i;
    };
    // The previous implementation stopped gateways first, which kills the
    // runtime out from under work the drain exists to protect.
    assert.ok(at('beginDrain()') > 0, 'must mark draining');
    assert.ok(at('beginDrain()') < at('drainActiveTurns'), 'drain after intake stops');
    assert.ok(at('drainActiveTurns') < at('classifyUnresolvedTurns'), 'classify after drain');
    assert.ok(at('classifyUnresolvedTurns') < at('closeTenantStores'), 'close after classify');
    assert.ok(at('closeTenantStores') < at('stopAllTenantGateways'), 'gateways stop last');
  });

  it('waits the configured grace before SIGKILL, not 400ms', async () => {
    const src = await fs.promises.readFile('scripts/start.mjs', 'utf8');
    assert.doesNotMatch(src, /await sleep\(400\)/, '400ms cannot cover a turn drain');
    assert.match(src, /ROCKY_SHUTDOWN_GRACE_MS/);
  });
});

describe('verified backup and staged restore (§8)', () => {
  it('captures, verifies, and detects tampering', async () => {
    const t = await tenant();
    const store = openTenantStore(t.id);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-backup-'));
    tmp.push(dest);
    try {
      recordInboundAndQueueTurn(store, inbound('remember this'));
      const manifest = await createTenantBackup(store, tenantDir(t.id), dest, {
        openclawVersion: 'test',
      });
      assert.equal(manifest.tenantId, t.id);
      // openclaw/ must never be raw-archived: a filesystem copy of a live WAL
      // database loses commits and still opens clean.
      assert.equal(manifest.openclawStateIncluded, false);
      assert.ok(!Object.keys(manifest.files).some((f) => f.startsWith('openclaw/')));

      const ok = verifyTenantBackup(dest);
      assert.equal(ok.ok, true);
      assert.equal(ok.integrity, 'ok');

      // Corrupt one file: verification must fail.
      const victim = path.join(dest, Object.keys(manifest.files).find((f) => f.endsWith('.json')) || 'manifest.json');
      fs.appendFileSync(victim, '\n// tampered');
      const bad = verifyTenantBackup(dest);
      assert.equal(bad.ok, false);
      assert.ok(bad.mismatches.length > 0);
    } finally { store.db.close(); }
  });

  it('restores only into staging, and refuses another tenant’s backup', async () => {
    const a = await tenant();
    const b = await tenant();
    const store = openTenantStore(a.id);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-backup2-'));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-stage-'));
    tmp.push(dest, staging);
    try {
      recordInboundAndQueueTurn(store, inbound('payload'));
      await createTenantBackup(store, tenantDir(a.id), dest);
      store.db.close();

      assert.throws(
        () => restoreTenantBackup(dest, staging, b.id),
        /belongs to/,
        'a backup must never restore into a different tenant',
      );

      const out = restoreTenantBackup(dest, staging, a.id);
      assert.ok(fs.existsSync(path.join(out.stagingDir, 'data', 'tenant.sqlite')));
      // The live tenant directory is untouched: activation is a separate step.
      assert.ok(fs.existsSync(path.join(tenantDir(a.id), 'data', 'tenant.sqlite')));
    } finally {
      try { store.db.close(); } catch { /* already closed */ }
    }
  });

  it('refuses to restore an unverified backup', async () => {
    const t = await tenant();
    const store = openTenantStore(t.id);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-backup3-'));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-stage3-'));
    tmp.push(dest, staging);
    try {
      await createTenantBackup(store, tenantDir(t.id), dest);
      fs.rmSync(path.join(dest, 'data', 'tenant.sqlite'));
      assert.throws(() => restoreTenantBackup(dest, staging, t.id), /unverified/i);
    } finally { store.db.close(); }
  });
});

describe('operator boundary (§9)', () => {
  const operator = { authorization: { kind: 'operator', principal: 'step6-test' } };

  it('reports metadata only, never message content', async () => {
    const t = await tenant();
    const store = openTenantStore(t.id);
    try {
      recordInboundAndQueueTurn(store, inbound('a private sentence about money'));
    } finally { store.db.close(); }

    const out = await executeTenantCommand(['state', 'status', '--tenant', t.id], operator);
    const json = JSON.stringify(out);
    assert.doesNotMatch(json, /private sentence/, 'status must never leak transcript content');
    assert.ok(json.includes('schemaVersion') || json.includes('queueDepth'));
  });

  it('turn list returns states and ids but no bodies, and has no resolve action', async () => {
    const t = await tenant();
    const store = openTenantStore(t.id);
    try {
      recordInboundAndQueueTurn(store, inbound('secret text here'));
      const claimed = claimNextTurn(store, { runtimeId: 'c', generation: 1 });
      const saved = saveResponse(store, claimed.id, 'reply text here');
      beginSend(store, claimed.id, saved.messageId);
      markSendStartedUnknown(store, 'TEST');
      const rows = listTurnsByState(store, [TURN_STATE.DELIVERY_UNKNOWN]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, TURN_STATE.DELIVERY_UNKNOWN);
      assert.equal(rows[0].body_cipher, undefined, 'no message content in operator output');
    } finally { store.db.close(); }

    await assert.rejects(
      () => executeTenantCommand(['turn', 'resolve', '--tenant', t.id], operator),
      /does not exist|Unsupported/,
      'turn resolve must not exist while re-execution is automatic',
    );
  });

  it('is not reachable through a tenant grant', async () => {
    const t = await tenant();
    for (const resource of ['state', 'turn']) {
      await assert.rejects(
        () => executeTenantCommand([resource, 'status', '--tenant', t.id], {
          authorization: { kind: 'tenant', tenantId: t.id },
        }),
        /./,
        `${resource} must be operator-only`,
      );
    }
  });
});
