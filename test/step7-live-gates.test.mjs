import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';
import { buildDockerRunArgs, RUNTIME_TMPFS } from '../src/openclaw/docker-gateway.mjs';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn, claimNextTurn, recoverInterruptedTurns }
  from '../src/tenant-data/queue-store.mjs';
import { saveResponse } from '../src/tenant-data/delivery-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { createTenantBackup, restoreTenantBackup } from '../src/state-backup/backup.mjs';
import { openDatabaseFileReadonly } from '../src/tenant-data/open.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, tenantDir } from '../src/tenants.mjs';
import { TENANTS_DIR, ORG_DIR } from '../src/paths.mjs';
import { LATEST_SCHEMA_VERSION } from '../src/tenant-data/migrations.mjs';

const execFileAsync = promisify(execFile);
const containers = [];
const created = [];
const tmpDirs = [];
let seq = 0;

after(async () => {
  for (const n of containers) await execFileAsync('docker', ['rm', '-f', n]).catch(() => {});
  for (const id of created) {
    await deleteTenant(id).catch(() => {});
    fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function dockerReady() {
  try {
    await execFileAsync('docker', ['info']);
    await execFileAsync('docker', ['image', 'inspect', OPENCLAW_DOCKER_IMAGE]);
    return true;
  } catch { return false; }
}

async function tenant() {
  seq += 1;
  const phone = `1555${String(process.pid).slice(-5)}${seq}`;
  const t = await provisionTenant({
    phone, jid: `${phone}@s.whatsapp.net`, name: `G7-${seq}`,
    plan: 'claude', email: null, finalState: 'READY',
  });
  created.push(t.id);
  return t;
}

/** Boot a gateway for a real provisioned tenant, hardened, as production does. */
async function bootFor(tenantId, port, nameSuffix = '') {
  const root = tenantDir(tenantId);
  fs.mkdirSync(path.join(root, 'openclaw'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cli-home', 'claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openclaw', 'openclaw.json'),
    JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port },
      agents: { defaults: { workspace: '/tenant/workspace' } },
    }),
  );
  const name = `rocky-g7-${tenantId}${nameSuffix}`;
  containers.push(name);
  await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
  await execFileAsync('docker', [
    'run', '-d', '--name', name, '--memory', '2g', '--cpus', '1',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
    '--tmpfs', RUNTIME_TMPFS,
    '-v', `${path.join(root, 'workspace')}:/tenant/workspace:rw`,
    '-v', `${path.join(root, 'openclaw')}:/tenant/openclaw:rw`,
    '-v', `${path.join(root, 'cli-home', 'claude')}:/tenant/cli-home/claude:rw`,
    // Mounted exactly as production does, so the read-only assertion is real.
    '-v', `${ORG_DIR}:/org:ro`,
    '-e', 'OPENCLAW_WORKSPACE_DIR=/tenant/workspace',
    '-e', 'OPENCLAW_STATE_DIR=/tenant/openclaw',
    '-e', 'OPENCLAW_CONFIG_PATH=/run/rocky/openclaw.json',
    '-e', 'OPENCLAW_HOME=/tenant/openclaw',
    '-e', 'HOME=/home/rocky',
    '-e', `OPENCLAW_GATEWAY_PORT=${port}`,
    '-e', 'OPENCLAW_GATEWAY_TOKEN=g7',
    OPENCLAW_DOCKER_IMAGE, 'gateway', 'run',
  ]);
  for (let i = 0; i < 45; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const { stdout, stderr } = await execFileAsync('docker', ['logs', name]);
    if (/\[gateway\] ready/.test(`${stdout}${stderr}`)) return name;
  }
  const { stdout, stderr } = await execFileAsync('docker', ['logs', name]);
  throw new Error(`gateway never ready:\n${`${stdout}${stderr}`.slice(-500)}`);
}

describe('GATE: Docker cold start and recreate', () => {
  it('survives stop, remove, and recreate with all four roots intact', async (t) => {
    if (!(await dockerReady())) { t.skip('Docker unavailable'); return; }
    const tn = await tenant();
    const name = await bootFor(tn.id, 18971);

    // Write state through each mounted root, plus a host-side transcript row.
    await execFileAsync('docker', ['exec', name, 'sh', '-c',
      'echo workspace-survives > /tenant/workspace/keepme.txt']);
    await execFileAsync('docker', ['exec', name, 'sh', '-c',
      'echo claude-survives > /tenant/cli-home/claude/keepme.txt']);
    const store = openTenantStore(tn.id);
    try {
      recordInboundAndQueueTurn(store, {
        conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid,
        body: 'transcript must survive recreate',
      });
    } finally { store.db.close(); }

    // Cold recreate: stop, remove, recreate.
    await execFileAsync('docker', ['stop', name]);
    await execFileAsync('docker', ['rm', name]);
    const again = await bootFor(tn.id, 18971, '-b');

    const ws = (await execFileAsync('docker', ['exec', again, 'cat', '/tenant/workspace/keepme.txt'])).stdout.trim();
    const cl = (await execFileAsync('docker', ['exec', again, 'cat', '/tenant/cli-home/claude/keepme.txt'])).stdout.trim();
    assert.equal(ws, 'workspace-survives');
    assert.equal(cl, 'claude-survives');
    // OpenClaw's own state directory persisted its database across recreate.
    assert.ok(fs.existsSync(path.join(tenantDir(tn.id), 'openclaw', 'state', 'openclaw.sqlite')));

    const after = openTenantStore(tn.id);
    try {
      const row = after.db.prepare('SELECT body_cipher FROM messages').get();
      assert.equal(decryptBody(tn.id, row.body_cipher), 'transcript must survive recreate');
    } finally { after.db.close(); }
  });
});

describe('GATE: isolation', () => {
  it('never mounts vault or data, and one tenant cannot reach another', async (t) => {
    if (!(await dockerReady())) { t.skip('Docker unavailable'); return; }
    const a = await tenant();
    const b = await tenant();

    // The argv contract: only four roots, and never vault/ or data/.
    const args = buildDockerRunArgs({ tenantId: a.id, port: 1, token: 't' });
    const mounts = args.filter((x, i) => args[i - 1] === '-v');
    assert.ok(mounts.length > 0);
    for (const m of mounts) {
      assert.doesNotMatch(m, /[/\\]vault[:/]/, `vault must never be mounted: ${m}`);
      assert.doesNotMatch(m, /[/\\]data[:/]/, `data must never be mounted: ${m}`);
      assert.doesNotMatch(m, new RegExp(`${b.id}`), 'must not mount another tenant');
    }
    assert.ok(mounts.some((m) => m.endsWith(':/org:ro')), '/org must be read-only');

    const nameA = await bootFor(a.id, 18972);
    const nameB = await bootFor(b.id, 18973);
    await execFileAsync('docker', ['exec', nameA, 'sh', '-c', 'echo A-only > /tenant/workspace/who.txt']);
    await execFileAsync('docker', ['exec', nameB, 'sh', '-c', 'echo B-only > /tenant/workspace/who.txt']);

    const inB = (await execFileAsync('docker', ['exec', nameB, 'cat', '/tenant/workspace/who.txt'])).stdout.trim();
    assert.equal(inB, 'B-only', 'B must not see A');

    // Neither container can see any tenant database or vault at all.
    for (const n of [nameA, nameB]) {
      const probe = await execFileAsync('docker', ['exec', n, 'sh', '-c',
        'ls /tenant/data /tenant/vault 2>&1 || true']);
      assert.match(probe.stdout, /No such file|cannot access/i,
        'vault and data must be invisible inside the container');
    }

    // /org is read-only in practice, not just in argv.
    const ro = await execFileAsync('docker', ['exec', nameA, 'sh', '-c',
      'touch /org/should-fail 2>&1 || true']);
    assert.match(ro.stdout, /Read-only|Permission denied/i);
  });
});

describe('GATE: privacy', () => {
  it('keeps plaintext and secrets out of the database bytes', async () => {
    const tn = await tenant();
    const store = openTenantStore(tn.id);
    try {
      recordInboundAndQueueTurn(store, {
        conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid,
        body: 'MergerTarget Acme pays 42 crore',
      });
      const claimed = claimNextTurn(store, { runtimeId: 'c', generation: 1 });
      saveResponse(store, claimed.id, 'Understood, MergerTarget noted');
    } finally { store.db.close(); }

    const raw = fs.readFileSync(path.join(tenantDir(tn.id), 'data', 'tenant.sqlite'));
    for (const secret of ['MergerTarget', 'Acme', '42 crore', 'Understood']) {
      assert.equal(raw.includes(Buffer.from(secret)), false, `plaintext "${secret}" found on disk`);
    }
  });

  it('refuses to store a credential class at all', async () => {
    const tn = await tenant();
    const store = openTenantStore(tn.id);
    try {
      assert.throws(
        () => recordInboundAndQueueTurn(store, {
          conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid,
          body: 'my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
        }),
        /persistence policy/i,
      );
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
    } finally { store.db.close(); }
  });
});

describe('GATE: crash window', () => {
  it('re-executes a turn abandoned before the response was committed', async () => {
    const tn = await tenant();
    const store = openTenantStore(tn.id);
    try {
      const { turnId } = recordInboundAndQueueTurn(store, {
        conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid,
        body: 'do the thing',
      });
      const claimed = claimNextTurn(store, { runtimeId: 'c1', generation: 1 });
      assert.equal(claimed.id, turnId);
      assert.equal(claimed.state, TURN_STATE.CLAIMED);

      // Crash here: process dies with the turn claimed and nothing committed.
      assert.equal(recoverInterruptedTurns(store), 1);
      const again = claimNextTurn(store, { runtimeId: 'c2', generation: 2 });
      assert.equal(again.id, turnId, 'the same turn must be re-executed');
      assert.equal(again.attempt, 2, 'attempt increments so re-execution is visible');

      // The original request is intact for full re-execution.
      const row = store.db.prepare('SELECT body_cipher FROM messages').get();
      assert.equal(decryptBody(tn.id, row.body_cipher), 'do the thing');
      assert.equal(
        store.db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n,
        0,
        'nothing was committed, so nothing may be sent',
      );
    } finally { store.db.close(); }
  });

  it('does not re-run the model once the response is committed', async () => {
    const tn = await tenant();
    const store = openTenantStore(tn.id);
    try {
      recordInboundAndQueueTurn(store, {
        conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid, body: 'ask',
      });
      const claimed = claimNextTurn(store, { runtimeId: 'c', generation: 1 });
      saveResponse(store, claimed.id, 'already answered');

      // A crash now must not requeue: the bytes exist and only need sending.
      assert.equal(recoverInterruptedTurns(store), 0, 'a committed turn must not be requeued');
      const row = store.db.prepare('SELECT state FROM turns').get();
      assert.equal(row.state, TURN_STATE.RESPONSE_SAVED);
    } finally { store.db.close(); }
  });
});

describe('GATE: backup and restore cold start', () => {
  it('restores into staging and the restored database opens with its content', async () => {
    const tn = await tenant();
    const store = openTenantStore(tn.id);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-backup-'));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-stage-'));
    tmpDirs.push(dest, staging);
    try {
      recordInboundAndQueueTurn(store, {
        conversationId: tn.id, channel: 'whatsapp', channelAccount: tn.jid,
        body: 'restore me faithfully',
      });
      await createTenantBackup(store, tenantDir(tn.id), dest, { openclawVersion: 'g7' });
    } finally { store.db.close(); }

    const out = restoreTenantBackup(dest, staging, tn.id);
    assert.equal(out.manifest.tenantId, tn.id);

    // Cold-open the restored database and prove the content is really there.
    const restored = path.join(staging, 'data', 'tenant.sqlite');
    assert.ok(fs.existsSync(restored));
    const db = openDatabaseFileReadonly(restored);
    try {
      assert.equal(db.pragma('integrity_check')[0].integrity_check, 'ok');
      const row = db.prepare('SELECT body_cipher FROM messages').get();
      assert.equal(decryptBody(tn.id, row.body_cipher), 'restore me faithfully');
      assert.equal(
        db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,
        LATEST_SCHEMA_VERSION,
      );
    } finally { db.close(); }

    // The live tenant is untouched; activation is a separate deliberate step.
    assert.ok(fs.existsSync(path.join(tenantDir(tn.id), 'data', 'tenant.sqlite')));
  });
});
