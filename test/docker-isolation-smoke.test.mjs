import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, tenantDir } from '../src/tenants.mjs';
import { ORG_DIR } from '../src/paths.mjs';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';
import {
  buildDockerRunArgs,
  dockerContainerName,
  dockerContainerState,
  dockerRemoveContainer,
  toDockerBindPath,
} from '../src/openclaw/docker-gateway.mjs';

const execFileAsync = promisify(execFile);

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['info'], { windowsHide: true, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function imageExists(name) {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['images', '-q', name],
      { windowsHide: true, timeout: 15_000 },
    );
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

describe('docker tenant isolation smoke', () => {
  const phoneA = `15558001${String(process.pid).slice(-4)}`;
  const phoneB = `15558002${String(process.pid).slice(-4)}`;
  const tenantIds = [];

  after(async () => {
    for (const id of tenantIds) {
      await dockerRemoveContainer(dockerContainerName(id)).catch(() => {});
      await deleteTenant(id);
    }
  });

  it('starts isolated containers that cannot mount vault or write org', async (t) => {
    if (!(await dockerAvailable())) {
      t.skip('Docker Engine/Desktop not available');
      return;
    }
    if (!(await imageExists(OPENCLAW_DOCKER_IMAGE))) {
      t.skip(`${OPENCLAW_DOCKER_IMAGE} image not built — run npm run docker:build:openclaw`);
      return;
    }

    const a = await provisionTenant({
      phone: phoneA,
      jid: `${phoneA}@s.whatsapp.net`,
      name: 'Docker A',
      plan: 'claude',
    });
    const b = await provisionTenant({
      phone: phoneB,
      jid: `${phoneB}@s.whatsapp.net`,
      name: 'Docker B',
      plan: 'claude',
    });
    tenantIds.push(a.id, b.id);

    await fs.mkdir(ORG_DIR, { recursive: true });
    await fs.writeFile(path.join(a.workspacePath, 'isolation-marker.txt'), 'A-only');
    await fs.writeFile(path.join(b.workspacePath, 'isolation-marker.txt'), 'B-only');
    await fs.writeFile(path.join(a.vaultPath, 'must-not-mount.txt'), 'A-vault');
    await fs.writeFile(path.join(b.vaultPath, 'must-not-mount.txt'), 'B-vault');

    const bindA = toDockerBindPath(tenantDir(a.id));
    const bindB = toDockerBindPath(tenantDir(b.id));
    assert.notEqual(bindA, bindB);
    assert.ok(bindA.includes(a.id));
    assert.ok(bindB.includes(b.id));

    assert.notEqual(dockerContainerName(a.id), dockerContainerName(b.id));
    assert.equal(await dockerContainerState(dockerContainerName(a.id)), 'missing');
    assert.equal(await dockerContainerState(dockerContainerName(b.id)), 'missing');

    const probe = [
      "const fs = require('fs');",
      "const own = fs.readFileSync('/tenant/workspace/isolation-marker.txt', 'utf8');",
      "if (own !== process.env.EXPECTED) throw new Error('wrong workspace mounted');",
      "if (fs.existsSync('/tenant/vault')) throw new Error('vault is mounted');",
      "let blocked = false;",
      "try { fs.writeFileSync('/org/isolation-write-probe', 'forbidden'); } catch { blocked = true; }",
      "if (!blocked) throw new Error('/org is writable');",
    ].join(' ');

    for (const [tenant, expected] of [[a, 'A-only'], [b, 'B-only']]) {
      const gatewayArgs = buildDockerRunArgs({
        tenantId: tenant.id,
        port: 18789,
        token: 'unused-test-token',
        image: OPENCLAW_DOCKER_IMAGE,
      });
      const mounts = [];
      for (let i = 0; i < gatewayArgs.length - 1; i += 1) {
        if (gatewayArgs[i] === '-v') mounts.push(gatewayArgs[i + 1]);
      }
      await execFileAsync('docker', [
        'run', '--rm', '--entrypoint', 'node',
        ...mounts.flatMap((mount) => ['-v', mount]),
        '-e', `EXPECTED=${expected}`,
        OPENCLAW_DOCKER_IMAGE,
        '-e', probe,
      ], { windowsHide: true, timeout: 60_000 });
    }
  });
});
