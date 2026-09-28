import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mcpServersHash, prepareTenantComposioRuntime, composioRuntimeProjectionPath } from '../src/mcp/composio-runtime.mjs';
import { tenantDir } from '../src/tenants.mjs';

const ENDPOINT = { url: 'https://backend.composio.dev/tool_router/trs_x/mcp', headers: { 'x-api-key': 'k' } };

function seedTenant() {
  process.env.ROCKY_AGENT_MCP_HOST = '172.17.0.1';
  const id = `br_${Math.random().toString(16).slice(2, 14)}`;
  const canonical = path.join(tenantDir(id), 'openclaw', 'openclaw.json');
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.writeFileSync(canonical, JSON.stringify({ agents: {} }));
  return { id, canonical, tenant: { id } };
}

test('an unchanged projection is not rewritten', async (t) => {
  const { id, canonical, tenant } = seedTenant();
  try {
    const first = await prepareTenantComposioRuntime(tenant, canonical, ENDPOINT);
    const file = composioRuntimeProjectionPath(id);
    const before = fs.statSync(file);
    const second = await prepareTenantComposioRuntime(tenant, canonical, ENDPOINT);
    const after = fs.statSync(file);

    await t.test('the inode survives, so a running container keeps its bind', () => {
      assert.equal(after.ino, before.ino, 'a rewrite allocates a new inode and breaks the bind');
    });

    await t.test('nothing was written the second time', () => {
      assert.equal(first.rewrote, true);
      assert.equal(second.rewrote, false);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(second.serversHash, first.serversHash);
    });

    await t.test('the mode is repaired even when the bytes match', async () => {
      fs.chmodSync(file, 0o644);
      await prepareTenantComposioRuntime(tenant, canonical, ENDPOINT);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });

    await t.test('a changed endpoint does rewrite, with a new hash', async () => {
      const changed = await prepareTenantComposioRuntime(tenant, canonical, {
        ...ENDPOINT,
        url: 'https://backend.composio.dev/tool_router/trs_y/mcp',
      });
      assert.equal(changed.rewrote, true);
      assert.notEqual(changed.serversHash, first.serversHash);
    });

    // Hibernation deletes the projection while the container's bind still
    // points at it, so Docker recreates the source as a root-owned DIRECTORY.
    // Measured on the deployment host 2026-09-22: every turn then failed with
    // `EACCES: rmdir .../composio.json`.
    await t.test('a directory left at the projection path is replaced, not fatal', async () => {
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file, { recursive: true });
      assert.ok(fs.lstatSync(file).isDirectory(), 'precondition: a directory sits there');

      const healed = await prepareTenantComposioRuntime(tenant, canonical, ENDPOINT);
      assert.ok(fs.lstatSync(file).isFile(), 'the projection must be a regular file again');
      assert.equal(healed.rewrote, true);
      assert.deepEqual(
        Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).servers).sort(),
        ['composio', 'rocky'],
      );
    });

    await t.test('both servers are always present', () => {
      const servers = JSON.parse(fs.readFileSync(file, 'utf8')).servers;
      assert.deepEqual(Object.keys(servers).sort(), ['composio', 'rocky']);
    });
  } finally {
    fs.rmSync(tenantDir(id), { recursive: true, force: true });
  }
});

test('the rocky server address cannot vary with the docker daemon', async (t) => {
  const src = fs.readFileSync('src/mcp/composio-runtime.mjs', 'utf8');

  await t.test('it uses the host alias, not a detected bridge IP', () => {
    assert.match(src, /host\.docker\.internal/);
    assert.doesNotMatch(src, /detectBridgeGateway/);
    assert.doesNotMatch(src, /the agent gets no Rocky tools/);
  });

  await t.test('every container is given that alias', () => {
    const gateway = fs.readFileSync('src/openclaw/docker-gateway.mjs', 'utf8');
    const args = gateway.slice(gateway.indexOf('export function buildDockerRunArgs'));
    assert.match(args, /'--add-host',\s*\n?\s*'host\.docker\.internal:host-gateway'/);
  });
});

test('the servers hash is stable for identical content', () => {
  const a = { composio: { url: 'u' }, rocky: { url: 'r' } };
  assert.equal(mcpServersHash(a), mcpServersHash({ composio: { url: 'u' }, rocky: { url: 'r' } }));
  assert.notEqual(mcpServersHash(a), mcpServersHash({ composio: { url: 'u2' }, rocky: { url: 'r' } }));
});

test('losing the Composio endpoint never deletes the bind-mount source', async () => {
  const { id, canonical, tenant } = seedTenant();
  try {
    await prepareTenantComposioRuntime(tenant, canonical, ENDPOINT);
    const file = composioRuntimeProjectionPath(id);
    assert.ok(fs.statSync(file).isFile());

    const after = await prepareTenantComposioRuntime(tenant, canonical, null);

    // Docker recreates a missing bind source as a root-owned directory, which
    // wedges the container at exit 127 and cannot be cleaned up by the gateway.
    assert.ok(fs.existsSync(file), 'projection must survive endpoint loss');
    assert.ok(fs.statSync(file).isFile(), 'projection must stay a regular file');
    assert.equal(after.projectionPath, file);

    const servers = JSON.parse(fs.readFileSync(file, 'utf8')).servers;
    assert.ok(!('composio' in servers), 'composio server is dropped');
    assert.ok('rocky' in servers, 'rocky server still reaches the container');
  } finally {
    fs.rmSync(tenantDir(id), { recursive: true, force: true });
  }
});
