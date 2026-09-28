import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINER_MCP_PROJECTION } from '../src/openclaw/container-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readOrgMcpRegistry, verifyOrgBundle } from '../src/mcp/org-bundle.mjs';
import { buildDockerRunArgs, RUNTIME_TMPFS } from '../src/openclaw/docker-gateway.mjs';
import { ensureTenantOpenclaw } from '../src/openclaw/tenant-openclaw.mjs';
import { PLATFORM_DIR } from '../src/paths.mjs';
import {
  createTenantClient,
  createTenantRuntimeClient,
  executeTenantCommand,
} from '../src/tenant-cli/index.mjs';
import { createConnectorAssertion } from '../src/tenant-cli/providers/composio/identity.mjs';
import {
  composioRuntimeSecretPaths,
  loadComposioPlatformCredentials,
} from '../src/tenant-cli/providers/composio/credentials.mjs';
import { tenantDir } from '../src/tenants.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';
import { withMockFetch } from './helpers.mjs';

const operator = { authorization: { kind: 'operator', principal: 'mcp-test' } };

function decodePart(token, index) {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8'));
}

async function configure() {
  return executeTenantCommand(
    ['mcp', 'configure', '--backend', 'composio', '--secret', 'test-composio-project-key'],
    operator,
  );
}

describe('Composio native MCP control plane', () => {
  it('keeps the org registry toolkit-only and manifest-valid', async () => {
    const registry = await readOrgMcpRegistry();
    assert.equal(registry.schemaVersion, 2);
    assert.equal(registry.provider, 'composio');
    // Frozen on purpose: adding a toolkit is a deliberate act, not something
    // that happens because someone edited a JSON file. `outlook` was once
    // removed because no auth config existed for it in Composio, so every
    // connect attempt failed at the provider with no way for the user to fix
    // it. It is back because `ac_McabwYHRri4T` now exists; the assertion below
    // is what keeps that from regressing.
    assert.deepEqual(Object.keys(registry.toolkits).sort(), [
      'asana', 'fireflies', 'gmail', 'googlecalendar', 'googledrive', 'linear',
      'outlook',
    ]);

    // An enabled toolkit with no pinned auth config makes the connector fall
    // back to "the first OAUTH2 config that mentions this toolkit", which is
    // how an over-broad consent screen reaches a user unnoticed.
    for (const [slug, entry] of Object.entries(registry.toolkits)) {
      if (entry.enabled !== true) continue;
      assert.match(
        String(entry.authConfigId || ''),
        /^ac_[A-Za-z0-9_-]+$/,
        `${slug} must pin the Composio auth config it connects through`,
      );
    }
    // No MCP *runtime* material may live in the org bundle.
    assert.doesNotMatch(JSON.stringify(registry), /headers|mcp\.asana|gmailmcp/i);
    // Every enabled toolkit must declare its surface explicitly: a read-only
    // include-list, or `access: "full"`. Omitting both must fail closed, so
    // full access can never be acquired by forgetting a filter.
    for (const [slug, entry] of Object.entries(registry.toolkits)) {
      if (!entry.enabled) continue;
      const include = entry.toolFilter?.include;
      const full = entry.access === 'full';
      assert.ok(
        full || (Array.isArray(include) && include.length > 0),
        `${slug} declares neither a toolFilter.include nor access: "full"`,
      );
      assert.ok(!(full && include), `${slug} must not set both access and a filter`);
      if (!full) {
        assert.doesNotMatch(
          include.join(','),
          /_SEND|_DELETE|_TRASH|_CREATE|_UPDATE|_REMOVE|_ARCHIVE|_MODIFY/i,
          `${slug} read-only include-list contains a write-capable action`,
        );
      }
    }

    assert.equal((await verifyOrgBundle()).ok, true);
  });

  it('encrypts platform credentials and signs short-lived tenant assertions', async () => {
    await configure();
    const file = path.join(PLATFORM_DIR, 'vault', 'composio-platform.json');
    const raw = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(raw)._rockyVault, 2);
    assert.doesNotMatch(raw, /test-composio-project-key|BEGIN PRIVATE KEY/);
    const runtimeSecrets = composioRuntimeSecretPaths();
    assert.equal((await fs.stat(runtimeSecrets.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(runtimeSecrets.apiKey)).mode & 0o777, 0o444);
    assert.equal((await fs.stat(runtimeSecrets.publicKey)).mode & 0o777, 0o444);

    const credentials = await loadComposioPlatformCredentials();
    const first = createConnectorAssertion('br_111111111111', credentials.assertionPrivateKey);
    const second = createConnectorAssertion('br_111111111111', credentials.assertionPrivateKey);
    assert.notEqual(first, second);
    const claims = decodePart(first, 1);
    assert.equal(claims.sub, 'br_111111111111');
    assert.ok(claims.exp - claims.iat <= 60);
    const [header, payload, signature] = first.split('.');
    assert.equal(crypto.verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: credentials.assertionPublicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ), true);
  });

  it('connects per tenant and hydrates only runtime config, never canonical plaintext', async () => {
    await configure();
    const suffix = String(Date.now()).slice(-8);
    const tenant = await provisionTenant({
      phone: `1554${suffix}`,
      jid: `1554${suffix}@s.whatsapp.net`,
      name: 'Composio Tenant',
      plan: 'claude',
    });
    const other = await provisionTenant({
      phone: `1555${suffix}`,
      jid: `1555${suffix}@s.whatsapp.net`,
      name: 'Other Tenant',
      plan: 'claude',
    });
    let active = false;
    const seenSubjects = [];
    try {
      await withMockFetch(async (url, init) => {
        const claims = decodePart(String(init.headers.Authorization).slice('Bearer '.length), 1);
        seenSubjects.push(claims.sub);
        if (url.endsWith('/api/v1/toolkits/gmail/connections') && init.method === 'POST') {
          assert.ok(init.headers['Idempotency-Key']);
          return {
            ok: true,
            status: 201,
            json: async () => ({
              connection_id: 'connection-a',
              redirect_url: 'https://connect.composio.dev/link/opaque',
            }),
          };
        }
        if (url.endsWith('/api/v1/connections')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{
              toolkit: 'gmail',
              connected: active,
              status: active ? 'ACTIVE' : 'INITIATED',
              connection_id: 'connection-a',
            }],
          };
        }
        if (url.endsWith('/api/v1/mcp/resolve')) {
          assert.deepEqual(JSON.parse(init.body), { toolkits: ['gmail'] });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              servers: {
                composio: {
                  type: 'http',
                  url: 'https://connect.composio.dev/mcp',
                  headers: { 'x-api-key': 'tenant-session-secret' },
                },
              },
            }),
          };
        }
        if (url.endsWith('/api/v1/toolkits/gmail/tools')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', description: 'Read' },
              { slug: 'GMAIL_SEND_EMAIL', name: 'Send', description: 'Write' },
            ],
          };
        }
        throw new Error(`Unexpected sidecar request: ${init.method || 'GET'} ${url}`);
      }, async () => {
        const client = createTenantClient({ tenantId: tenant.id, principal: `test:${tenant.id}` });
        const available = await client.mcp().available();
        assert.ok(available.result.toolkits.some((item) => item.slug === 'gmail'));
        const tools = await client.mcp().tools('gmail');
        assert.deepEqual(tools.result.tools.map((tool) => tool.slug), [
          'GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL',
        ]);
        const connected = await client.mcp().connect('gmail');
        assert.match(connected.result.connectLink, /^https:\/\/connect\.composio\.dev/);

        const vaultRaw = await fs.readFile(
          path.join(tenantDir(tenant.id), 'vault', 'composio-mcp.json'),
          'utf8',
        );
        assert.equal(JSON.parse(vaultRaw)._rockyVault, 2);
        assert.doesNotMatch(vaultRaw, /connect\.composio|connection-a/);
        const audit = await fs.readFile(path.join(tenantDir(tenant.id), 'audit.jsonl'), 'utf8');
        assert.doesNotMatch(audit, /connect\.composio\.dev|tenant-session-secret/);

        active = true;
        const synced = await client.mcp().sync({ 'pending-only': true });
        assert.equal(synced.result.endpointReady, true);

        const canonical = await ensureTenantOpenclaw(tenant);
        const hydrated = await createTenantRuntimeClient({ tenantId: tenant.id })
          .hydrateMcp(canonical.configPath);
        const runtimeConfig = JSON.parse(await fs.readFile(hydrated.result.configPath, 'utf8'));
        assert.equal(runtimeConfig.mcp.servers.composio.url, 'https://connect.composio.dev/mcp');
        assert.equal(runtimeConfig.mcp.servers.composio.headers['x-api-key'], 'tenant-session-secret');
        const canonicalRaw = await fs.readFile(canonical.configPath, 'utf8');
        assert.doesNotMatch(canonicalRaw, /connect\.composio|tenant-session-secret/);

        const args = buildDockerRunArgs({ tenantId: tenant.id, port: 18880, token: 'gw' });
        assert.ok(args.includes(RUNTIME_TMPFS));
        assert.ok(args.some((arg) => arg.endsWith(`:${CONTAINER_MCP_PROJECTION}:ro`)));

        const otherCanonical = await ensureTenantOpenclaw(other);
        const otherRuntime = await createTenantRuntimeClient({ tenantId: other.id })
          .hydrateMcp(otherCanonical.configPath);
        const otherConfig = JSON.parse(await fs.readFile(otherRuntime.result.configPath, 'utf8'));
        assert.equal(otherConfig.mcp?.servers?.composio, undefined);
      });
      assert.ok(seenSubjects.length >= 4);
      assert.ok(seenSubjects.every((subject) => subject === tenant.id));
    } finally {
      await deleteTenant(tenant.id);
      await deleteTenant(other.id);
    }
  });

  it('removes the provider-specific and generic remote MCP command surface', async () => {
    const client = createTenantClient({ tenantId: 'br_222222222222' }).mcp();
    for (const removed of ['add', 'show', 'probe', 'enable', 'disable', 'login', 'logout', 'reload', 'remove']) {
      assert.equal(client[removed], undefined);
    }
    await assert.rejects(
      executeTenantCommand(
        ['mcp', 'revoke', '--tenant', 'br_222222222222'],
        { authorization: { kind: 'tenant', tenantId: 'br_222222222222' } },
      ),
      /not authorized/i,
    );
  });
});
