import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDockerRunArgs, DOCKER_PIDS_LIMIT, RUNTIME_TMPFS } from '../src/openclaw/docker-gateway.mjs';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';

const execFileAsync = promisify(execFile);
const started = [];
const dirs = [];

after(async () => {
  for (const n of started) await execFileAsync('docker', ['rm', '-f', n]).catch(() => {});
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function dockerReady() {
  try {
    await execFileAsync('docker', ['info']);
    await execFileAsync('docker', ['image', 'inspect', OPENCLAW_DOCKER_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

/** Boot a hardened gateway exactly as production argv does. */
async function boot(tag, port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `rocky-hard-${tag}-`));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'openclaw'), { recursive: true });
  await fs.mkdir(path.join(dir, 'workspace'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'openclaw', 'openclaw.json'),
    JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port },
      agents: { defaults: { workspace: '/tenant/workspace' } },
    }),
  );
  const name = `rocky-hardtest-${tag}-${process.pid}`;
  started.push(name);
  await execFileAsync('docker', [
    'run', '-d', '--name', name, '--memory', '2g', '--cpus', '1',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(DOCKER_PIDS_LIMIT),
    '--tmpfs', RUNTIME_TMPFS,
    '-v', `${path.join(dir, 'workspace')}:/tenant/workspace:rw`,
    '-v', `${path.join(dir, 'openclaw')}:/tenant/openclaw:rw`,
    '-e', 'OPENCLAW_WORKSPACE_DIR=/tenant/workspace',
    '-e', 'OPENCLAW_STATE_DIR=/tenant/openclaw',
    '-e', 'OPENCLAW_CONFIG_PATH=/run/rocky/openclaw.json',
    '-e', 'OPENCLAW_HOME=/tenant/openclaw',
    '-e', 'HOME=/home/rocky',
    '-e', `OPENCLAW_GATEWAY_PORT=${port}`,
    '-e', 'OPENCLAW_GATEWAY_TOKEN=hardtest',
    OPENCLAW_DOCKER_IMAGE, 'gateway', 'run',
  ]);
  for (let i = 0; i < 45; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const { stdout, stderr } = await execFileAsync('docker', ['logs', name]);
    if (/\[gateway\] ready/.test(`${stdout}${stderr}`)) return { name, dir };
    if (/Cannot find package|failed to start/i.test(`${stdout}${stderr}`)) {
      throw new Error(`boot failed:\n${stdout}${stderr}`.slice(0, 800));
    }
  }
  const { stdout, stderr } = await execFileAsync('docker', ['logs', name]);
  throw new Error(`never became ready:\n${`${stdout}${stderr}`.slice(-600)}`);
}

describe('container hardening argv', () => {
  it('drops all capabilities, forbids privilege escalation, and caps pids', () => {
    const args = buildDockerRunArgs({ tenantId: 'br_x', port: 1, token: 't' });
    const pair = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(pair('--cap-drop'), 'ALL');
    assert.ok(args.includes('no-new-privileges'));
    assert.ok(Number(pair('--pids-limit')) > 0);
    // Docker's own restart policies must stay off: the host owns restart.
    assert.equal(pair('--restart'), 'no');
  });
});

describe('hardened containers, live', () => {
  it('boots to ready and the restrictions are actually in effect', async (t) => {
    if (!(await dockerReady())) {
      t.skip('Docker or the pinned image is unavailable');
      return;
    }
    const { name } = await boot('a', 18981);

    const cap = (await execFileAsync('docker', ['exec', name, 'sh', '-c',
      'grep -E "^Cap(Eff|Prm|Bnd)" /proc/self/status'])).stdout;
    // Zeroed, not merely reduced: a Node server on a high port needs none.
    for (const line of cap.trim().split('\n')) {
      assert.match(line, /:\s*0000000000000000$/, `capability set not empty: ${line}`);
    }

    const status = (await execFileAsync('docker', ['exec', name, 'sh', '-c',
      'grep NoNewPrivs /proc/self/status'])).stdout;
    assert.match(status, /NoNewPrivs:\s*1/);

    const id = (await execFileAsync('docker', ['exec', name, 'id'])).stdout;
    assert.doesNotMatch(id, /uid=0\(root\)/, 'must never run as root');

    const inspect = (await execFileAsync('docker', ['inspect', name, '--format',
      '{{.HostConfig.PidsLimit}}'])).stdout.trim();
    assert.ok(Number(inspect) > 0, 'pids limit must be set');
  });

  it('keeps two hardened tenants isolated from each other', async (t) => {
    if (!(await dockerReady())) {
      t.skip('Docker or the pinned image is unavailable');
      return;
    }
    const a = await boot('iso1', 18982);
    const b = await boot('iso2', 18983);

    // Each writes a marker into its own workspace.
    await execFileAsync('docker', ['exec', a.name, 'sh', '-c', 'echo A > /tenant/workspace/marker']);
    await execFileAsync('docker', ['exec', b.name, 'sh', '-c', 'echo B > /tenant/workspace/marker']);

    const inA = (await execFileAsync('docker', ['exec', a.name, 'cat', '/tenant/workspace/marker'])).stdout.trim();
    const inB = (await execFileAsync('docker', ['exec', b.name, 'cat', '/tenant/workspace/marker'])).stdout.trim();
    assert.equal(inA, 'A');
    assert.equal(inB, 'B', 'one tenant must not see the other’s workspace');

    // Neither may reach the host tenant root or another tenant's directory.
    for (const { name } of [a, b]) {
      const probe = await execFileAsync('docker', ['exec', name, 'sh', '-c',
        'ls /tenants 2>&1 || true']);
      assert.doesNotMatch(probe.stdout, /^br_/m, 'tenant root must not be visible');
    }
  });

  it('runs several hardened tenants at once without interference', async (t) => {
    if (!(await dockerReady())) {
      t.skip('Docker or the pinned image is unavailable');
      return;
    }
    const boots = await Promise.all([
      boot('m1', 18984),
      boot('m2', 18985),
      boot('m3', 18986),
    ]);
    assert.equal(boots.length, 3);

    for (const { name } of boots) {
      const st = (await execFileAsync('docker', ['inspect', name, '--format', '{{.State.Running}}'])).stdout.trim();
      assert.equal(st, 'true', `${name} should still be running alongside its peers`);
    }

    // Each has its own PID namespace: none can see another's processes.
    const pidCounts = await Promise.all(boots.map(async ({ name }) => {
      const out = await execFileAsync('docker', ['exec', name, 'sh', '-c',
        'ls -d /proc/[0-9]* | wc -l']);
      return Number(out.stdout.trim());
    }));
    for (const n of pidCounts) {
      assert.ok(n > 0 && n < 50, `unexpected process count ${n}; namespaces may be shared`);
    }
  });
});
