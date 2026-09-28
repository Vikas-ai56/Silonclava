import { execFile } from 'node:child_process';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  prepareTenantComposioRuntime,
  clearTenantComposioRuntime,
} from '../src/mcp/composio-runtime.mjs';
import {
  buildDockerRunArgs,
  dockerContainerName,
  dockerRemoveContainer,
} from '../src/openclaw/docker-gateway.mjs';
import { ensureTenantOpenclaw } from '../src/openclaw/tenant-openclaw.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';

const execFileAsync = promisify(execFile);
const image = OPENCLAW_DOCKER_IMAGE;

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['info'], { windowsHide: true, timeout: 15_000 });
    const { stdout } = await execFileAsync('docker', ['images', '-q', image], {
      windowsHide: true,
      timeout: 15_000,
    });
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

function foregroundArgs(args, command) {
  const imageIndex = args.lastIndexOf(image);
  assert.ok(imageIndex > 0, 'OpenClaw image missing from docker argv');
  const options = args.slice(1, imageIndex);
  const kept = [];
  for (let index = 0; index < options.length; index += 1) {
    const value = options[index];
    if (value === '-d') continue;
    if (['--name', '--restart', '-p'].includes(value)) {
      index += 1;
      continue;
    }
    kept.push(value);
  }
  return ['run', '--rm', ...kept, image, ...command];
}

describe('Composio Docker runtime smoke', () => {
  const phone = `15559001${String(process.pid).slice(-4)}`;
  let tenant = null;

  after(async () => {
    if (!tenant) return;
    await dockerRemoveContainer(dockerContainerName(tenant.id)).catch(() => {});
    await clearTenantComposioRuntime(tenant.id);
    await deleteTenant(tenant.id);
  });

  it('injects one native MCP server through tmpfs without changing canonical state', async (t) => {
    if (!(await dockerAvailable())) {
      t.skip(`Docker or ${image} is unavailable`);
      return;
    }

    tenant = await provisionTenant({
      phone,
      jid: `${phone}@s.whatsapp.net`,
      name: 'Composio Docker',
      plan: 'claude',
    });
    const canonical = await ensureTenantOpenclaw(tenant);
    await prepareTenantComposioRuntime(tenant, canonical.configPath, {
      url: 'https://connect.composio.dev/mcp',
      headers: { Authorization: 'Bearer docker-smoke-secret' },
    });

    const base = buildDockerRunArgs({
      tenantId: tenant.id,
      port: 18889,
      token: 'docker-smoke-token',
      image,
    });
    assert.ok(base.some((arg) => arg.endsWith(':/run/rocky-input/composio.json:ro')));

    const validation = await execFileAsync(
      'docker',
      foregroundArgs(base, ['config', 'validate', '--json']),
      { windowsHide: true, timeout: 60_000 },
    );
    assert.match(validation.stdout, /"valid"\s*:\s*true/);

    const projected = await execFileAsync(
      'docker',
      foregroundArgs(base, ['config', 'get', 'mcp.servers.composio', '--json']),
      { windowsHide: true, timeout: 60_000 },
    );
    const server = JSON.parse(projected.stdout);
    assert.equal(server.url, 'https://connect.composio.dev/mcp');
    assert.equal(server.headers.Authorization, 'Bearer docker-smoke-secret');

    const canonicalRaw = await fs.readFile(canonical.configPath, 'utf8');
    assert.doesNotMatch(canonicalRaw, /connect\.composio\.dev|docker-smoke-secret/);
  });
});
