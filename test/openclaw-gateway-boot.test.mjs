import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';
import { RUNTIME_TMPFS } from '../src/openclaw/docker-gateway.mjs';

const execFileAsync = promisify(execFile);

async function imageExists(image) {
  try {
    await execFileAsync('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate that would have caught the 2026.7.33 pin bump.
 *
 * `openclaw config validate` passes on a release whose gateway cannot start,
 * because validation never resolves the runtime's module graph. 2026.7.33
 * declares `@openclaw/ai` but npm silently omits it, so the gateway dies with
 * `Cannot find package '@openclaw/ai'` — and 216 unit tests stayed green.
 */
describe('pinned image can actually run', () => {
  it('starts a gateway to ready', async (t) => {
    if (!(await imageExists(OPENCLAW_DOCKER_IMAGE))) {
      t.skip(`${OPENCLAW_DOCKER_IMAGE} not built — run npm run docker:build:openclaw`);
      return;
    }
    // Neither `config validate` nor `--version` catches a missing runtime
    // dependency: 2026.7.33 passes both and still dies at gateway start. Only
    // reaching `[gateway] ready` proves the runtime module graph resolves.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-gwboot-'));
    const name = `rocky-gwboot-${process.pid}`;
    try {
      await fs.mkdir(path.join(dir, 'openclaw'), { recursive: true });
      await fs.mkdir(path.join(dir, 'workspace'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'openclaw', 'openclaw.json'),
        JSON.stringify({
          gateway: { mode: 'local', bind: 'loopback', port: 18997 },
          agents: { defaults: { workspace: '/tenant/workspace' } },
        }),
      );

      await execFileAsync('docker', [
        'run', '-d', '--name', name, '--memory', '2g', '--cpus', '1',
        '--tmpfs', RUNTIME_TMPFS,
        '-v', `${path.join(dir, 'workspace')}:/tenant/workspace:rw`,
        '-v', `${path.join(dir, 'openclaw')}:/tenant/openclaw:rw`,
        '-e', 'OPENCLAW_WORKSPACE_DIR=/tenant/workspace',
        '-e', 'OPENCLAW_STATE_DIR=/tenant/openclaw',
        '-e', 'OPENCLAW_CONFIG_PATH=/run/rocky/openclaw.json',
        '-e', 'OPENCLAW_HOME=/tenant/openclaw',
        '-e', 'HOME=/home/rocky',
        '-e', 'OPENCLAW_GATEWAY_PORT=18997',
        '-e', 'OPENCLAW_GATEWAY_TOKEN=boot-gate',
        OPENCLAW_DOCKER_IMAGE, 'gateway', 'run',
      ]);

      let logs = '';
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const { stdout, stderr } = await execFileAsync('docker', ['logs', name]);
        logs = `${stdout}${stderr}`;
        if (/\[gateway\] ready/.test(logs)) break;
        if (/Cannot find package|Could not start the CLI/.test(logs)) break;
      }
      assert.doesNotMatch(logs, /Cannot find package/, `missing runtime dependency:\n${logs.slice(-600)}`);
      assert.match(logs, /\[gateway\] ready/, `gateway never became ready:\n${logs.slice(-600)}`);
    } finally {
      await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('ships every @openclaw runtime package it declares', async (t) => {
    if (!(await imageExists(OPENCLAW_DOCKER_IMAGE))) {
      t.skip(`${OPENCLAW_DOCKER_IMAGE} not built`);
      return;
    }
    const root = '/usr/local/lib/node_modules/openclaw';
    const { stdout: declared } = await execFileAsync('docker', [
      'run', '--rm', '--entrypoint', 'node', OPENCLAW_DOCKER_IMAGE, '-e',
      `const d=require('${root}/package.json').dependencies||{};` +
        `console.log(Object.keys(d).filter(k=>k.startsWith('@openclaw/')).join(','))`,
    ]);
    const { stdout: present } = await execFileAsync('docker', [
      'run', '--rm', '--entrypoint', 'sh', OPENCLAW_DOCKER_IMAGE, '-c',
      `ls ${root}/node_modules/@openclaw 2>/dev/null | tr '\\n' ',';` +
        `ls /usr/local/lib/node_modules/@openclaw 2>/dev/null | tr '\\n' ','`,
    ]);

    const want = declared.trim().split(',').filter(Boolean).map((n) => n.replace('@openclaw/', ''));
    const have = new Set(present.trim().split(',').filter(Boolean));
    const missing = want.filter((n) => !have.has(n));
    assert.deepEqual(
      missing,
      [],
      `openclaw declares @openclaw/{${want}} but the image lacks {${missing}} — ` +
        'npm can silently omit a declared dependency; the gateway then cannot start',
    );
  });
});
