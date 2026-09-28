import {
  clearTenantComposioRuntime,
  prepareTenantComposioRuntime,
  tenantHasCanonicalPlaintextMcp,
} from '../../mcp/composio-runtime.mjs';
import {
  approvedToolkitsForTenant,
  readOrgMcpRegistry,
  verifyOrgBundle,
} from '../../mcp/org-bundle.mjs';
import path from 'node:path';
import { recycleTenantGateway } from '../../openclaw/tenant-gateway.mjs';
import { listTenants, loadTenant, tenantDir } from '../../tenants.mjs';
import { createComposioSidecarClient } from '../providers/composio/client.mjs';
import {
  composioPlatformStatus,
  configureComposioPlatform,
} from '../providers/composio/credentials.mjs';
import {
  deleteTenantComposioState,
  readTenantComposioState,
  updateTenantComposioState,
} from '../providers/composio/state.mjs';

function connectionIdParam(params) {
  const value = String(params.connection || '').trim();
  if (!/^ca_[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error('A valid --connection id is required (ca_...)');
  }
  return value;
}

function describeAccount(item) {
  return item.displayName || item.account || item.connectionId || 'unknown';
}

function toolkitParam(params) {
  const value = String(params.toolkit || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('A valid --toolkit is required');
  }
  return value;
}

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  if (!tenantId) throw new Error(`--tenant is required for mcp ${request.action}`);
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

async function orgContext(tenant = null) {
  const verification = await verifyOrgBundle();
  if (!verification.ok) {
    throw new Error(`Organization bundle verification failed: ${verification.errors.join('; ')}`);
  }
  const registry = await readOrgMcpRegistry();
  const toolkits = tenant
    ? approvedToolkitsForTenant(registry, tenant)
    : Object.entries(registry.toolkits)
      .filter(([, entry]) => entry.enabled === true)
      .map(([slug, entry]) => ({ slug, ...entry }));
  return { verification, registry, toolkits };
}

async function requireApprovedToolkit(tenant, toolkit) {
  const context = await orgContext(tenant);
  const entry = context.toolkits.find((item) => item.slug === toolkit);
  if (!entry) throw new Error(`Toolkit ${toolkit} is not enabled for this tenant`);
  return entry;
}

function normalizedConnections(connections) {
  return connections.map((item) => ({
    toolkit: String(item.toolkit || ''),
    connected: item.connected === true,
    status: item.status || null,
    connectionId: item.connection_id || null,
    account: item.account || null,
    displayName: item.display_name || null,
  }));
}

export function activeConnectionFingerprint(connections, approved) {
  return (connections || [])
    .filter((item) => item.connected && item.status === 'ACTIVE'
      && (!approved || approved.has(item.toolkit)))
    .map((item) => `${item.toolkit}:${item.connectionId}`)
    .sort()
    .join('|');
}

async function resolveEndpoint(client, activeToolkits) {
  const resolved = activeToolkits.length ? await client.resolve(activeToolkits) : { servers: {} };
  const server = resolved?.servers?.composio || null;
  return server ? { url: server.url, headers: server.headers || null } : null;
}

async function syncTenant(tenant, { pendingOnly = false } = {}) {
  const before = await readTenantComposioState(tenant.id);
  const hasPending = before?.connections?.some((item) =>
    ['INITIALIZING', 'INITIATED'].includes(item.status));
  if (pendingOnly && (!before || (before.endpoint && !hasPending))) {
    return { changed: false, skipped: true, activeToolkits: [] };
  }

  const { toolkits } = await orgContext(tenant);
  const approved = new Set(toolkits.map((item) => item.slug));
  const client = createComposioSidecarClient(tenant.id);
  const connections = normalizedConnections(await client.connections());
  const activeToolkits = [...new Set(
    connections
      .filter((item) => item.connected && item.status === 'ACTIVE' && approved.has(item.toolkit))
      .map((item) => item.toolkit),
  )];
  const reusable = before?.endpoint
    && activeConnectionFingerprint(before.connections, approved) === activeConnectionFingerprint(connections, approved);

  const endpoint = reusable
    ? before.endpoint
    : await resolveEndpoint(client, activeToolkits);

  const next = {
    version: 1,
    connections,
    endpoint,
    syncedAt: new Date().toISOString(),
  };
  const changed = !reusable
    && JSON.stringify(before?.endpoint || null) !== JSON.stringify(endpoint);
  await updateTenantComposioState(tenant.id, () => next);
  if (changed) await recycleTenantGateway(tenant.id);
  return { changed, activeToolkits, connected: connections, endpointReady: Boolean(endpoint) };
}

export async function handleResourceAction(request) {
  const { action, params } = request;

  if (action === 'configure') {
    if (String(params.backend || '').toLowerCase() !== 'composio') {
      throw new Error('mcp configure supports only --backend composio');
    }
    const result = await configureComposioPlatform(params.secret);
    return {
      mutating: true,
      auditScope: 'platform',
      auditParams: { backend: 'composio', secret: '[REDACTED]' },
      result,
    };
  }

  if (action === 'available') {
    const tenant = request.target?.tenantId ? await tenantFor(request) : null;
    const { verification, toolkits } = await orgContext(tenant);
    const query = String(params.query || '').trim().toLowerCase();
    const filtered = query
      ? toolkits.filter((item) => `${item.slug} ${item.displayName || ''}`.toLowerCase().includes(query))
      : toolkits;
    return {
      tenantId: tenant?.id || null,
      mutating: false,
      result: { orgVersion: verification.version, provider: 'composio', toolkits: filtered },
    };
  }

  if (action === 'sync-all') {
    const results = [];
    for (const target of await listTenants()) {
      try {
        results.push({ tenantId: target.id, ok: true, ...(await syncTenant(target)) });
      } catch (err) {
        results.push({ tenantId: target.id, ok: false, error: String(err?.message || err) });
      }
    }
    return { mutating: true, auditScope: 'platform', result: { tenants: results } };
  }

  const tenant = await tenantFor(request);

  if (action === 'hydrate') {
    const canonicalConfigPath = path.resolve(String(params.canonicalConfigPath || ''));
    const expectedConfigPath = path.resolve(tenantDir(tenant.id), 'openclaw', 'openclaw.json');
    if (canonicalConfigPath !== expectedConfigPath) {
      throw new Error('Runtime MCP hydration path is outside the target tenant');
    }
    const state = await readTenantComposioState(tenant.id);
    const runtime = await prepareTenantComposioRuntime(
      tenant,
      canonicalConfigPath,
      state?.endpoint || null,
    );
    return { tenantId: tenant.id, mutating: false, result: runtime };
  }

  const client = createComposioSidecarClient(tenant.id);

  if (action === 'tools') {
    const toolkit = toolkitParam(params);
    await requireApprovedToolkit(tenant, toolkit);
    return {
      tenantId: tenant.id,
      mutating: false,
      result: { toolkit, tools: await client.tools(toolkit) },
    };
  }

  if (action === 'list' || action === 'status') {
    const toolkit = params.toolkit ? toolkitParam(params) : null;
    const connections = normalizedConnections(await client.connections())
      .filter((item) => !toolkit || item.toolkit === toolkit);
    return {
      tenantId: tenant.id,
      mutating: false,
      result: { backend: 'composio', connections },
    };
  }

  if (action === 'connect') {
    const toolkit = toolkitParam(params);
    await requireApprovedToolkit(tenant, toolkit);
    const connection = await client.connect(toolkit);
    await updateTenantComposioState(tenant.id, (current) => ({
      version: 1,
      ...(current || {}),
      connections: [
        ...(current?.connections || [])
          .filter((item) => item.connectionId !== connection.connection_id),
        {
          toolkit,
          connected: false,
          status: 'INITIATED',
          connectionId: connection.connection_id,
          account: null,
          displayName: null,
        },
      ],
      updatedAt: new Date().toISOString(),
    }));
    const connectLink = connection.redirect_url;
    return {
      tenantId: tenant.id,
      mutating: true,
      auditParams: { toolkit },
      auditResult: { toolkit, connectionId: connection.connection_id, connectLink: '[REDACTED]' },
      result: {
        toolkit,
        connectionId: connection.connection_id,
        connectLink,
        message: `Open this link to connect ${toolkit}:\n${connectLink}\n\nReturn to WhatsApp when complete.`,
      },
    };
  }

  if (action === 'disconnect') {
    const toolkit = toolkitParam(params);
    await requireApprovedToolkit(tenant, toolkit);
    const connectionId = params.connection ? connectionIdParam(params) : null;
    const existing = normalizedConnections(await client.connections())
      .filter((item) => item.toolkit === toolkit);
    if (!connectionId && existing.length > 1) {
      throw new Error(
        `${toolkit} has ${existing.length} connected accounts `
        + `(${existing.map(describeAccount).join(', ')}). `
        + 'Pass --connection <id> to remove one, or use `mcp revoke` to clear every toolkit.',
      );
    }
    await client.disconnect(toolkit, connectionId);
    const sync = await syncTenant(tenant);
    return {
      tenantId: tenant.id,
      mutating: true,
      auditParams: { toolkit, connectionId },
      result: { toolkit, connectionId, removed: connectionId ? 1 : existing.length, sync },
    };
  }

  if (action === 'sync') {
    const result = await syncTenant(tenant, { pendingOnly: params['pending-only'] === true });
    return { tenantId: tenant.id, mutating: !result.skipped, result };
  }

  if (action === 'doctor') {
    const [platform, bundle, state, connections, canonicalLeak] = await Promise.all([
      composioPlatformStatus(),
      verifyOrgBundle(),
      readTenantComposioState(tenant.id),
      client.connections(),
      tenantHasCanonicalPlaintextMcp(tenant.id),
    ]);
    return {
      tenantId: tenant.id,
      mutating: false,
      result: {
        ok: platform.configured && bundle.ok && !canonicalLeak,
        platform,
        orgBundle: bundle,
        storedEndpoint: Boolean(state?.endpoint),
        connectionCount: connections.length,
        canonicalPlaintextMcp: canonicalLeak,
      },
    };
  }

  if (action === 'revoke') {
    const connections = normalizedConnections(await client.connections());
    const failures = [];
    for (const toolkit of new Set(connections.map((item) => item.toolkit).filter(Boolean))) {
      try {
        await client.disconnect(toolkit);
      } catch (err) {
        failures.push({ toolkit, error: String(err?.message || err) });
      }
    }
    if (failures.length) throw new Error(`Could not revoke all toolkits: ${failures.map((item) => item.toolkit).join(', ')}`);
    await deleteTenantComposioState(tenant.id);
    await clearTenantComposioRuntime(tenant.id);
    await recycleTenantGateway(tenant.id);
    return { tenantId: tenant.id, mutating: true, result: { revoked: true } };
  }

  throw new Error(`Unsupported mcp action: ${action || '<empty>'}`);
}
