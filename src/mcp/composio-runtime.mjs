import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLATFORM_DIR } from '../paths.mjs';
import { tenantDir } from '../tenants.mjs';

function runtimeDirectory(tenantId) {
  const id = String(tenantId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid tenant id for MCP runtime');
  // Not the OS temp dir: a bind source must outlive the gateway process (P1).
  return path.join(PLATFORM_DIR, 'runtime', 'openclaw', id);
}

export function composioRuntimeProjectionPath(tenantId) {
  return path.join(runtimeDirectory(tenantId), 'composio.json');
}

export function composioRuntimeConfigPath(tenantId) {
  return path.join(runtimeDirectory(tenantId), 'openclaw.json');
}

function validateEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') throw new Error('Missing Composio MCP endpoint');
  const parsed = new URL(String(endpoint.url || ''));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Composio MCP endpoint must be credential-free HTTPS');
  }
  const headers = endpoint.headers == null ? null : Object.fromEntries(
    Object.entries(endpoint.headers).map(([key, value]) => [String(key), String(value)]),
  );
  return { url: parsed.toString(), headers };
}

/**
 * Rocky's own MCP server, reachable from the container over the Docker bridge
 * and from nowhere else. The token is the tenant's stable agent credential, so
 * the container can only ever act as itself.
 */
export const AGENT_MCP_CONTAINER_HOST = 'host.docker.internal';

async function rockyAgentServer(tenantId) {
  const { AGENT_MCP_PATH } = await import('../agent-mcp.mjs');
  const { ensureAgentCredential } = await import('../openclaw/tenant-onboarding.mjs');
  const { PORT } = await import('../config.mjs');

  const host = process.env.ROCKY_AGENT_MCP_HOST || AGENT_MCP_CONTAINER_HOST;
  const { token } = await ensureAgentCredential(tenantId);
  return {
    url: `http://${host}:${PORT}${AGENT_MCP_PATH}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function mcpServersHash(servers) {
  return crypto.createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16);
}

async function ensureRegularFile(file) {
  const stat = await fs.lstat(file).catch(() => null);
  if (stat && !stat.isFile()) {
    await fs.rm(file, { recursive: true, force: true });
    return false;
  }
  return Boolean(stat);
}

async function writeIfChanged(file, body) {
  const existed = await ensureRegularFile(file);
  const current = existed ? await fs.readFile(file, 'utf8').catch(() => null) : null;
  if (current !== body) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, body, { mode: 0o600 });
    await fs.rename(temp, file);
  }
  await fs.chmod(file, 0o600);
  return current !== body;
}

export async function prepareTenantComposioRuntime(tenant, canonicalConfigPath, rawEndpoint) {
  const directory = runtimeDirectory(tenant.id);
  // Never `rm` this directory here. It is a live bind-mount source: a stopped
  // container still holds it, and Docker recreates a missing source as a
  // root-owned DIRECTORY on the next run/start. That wedges the container at
  // exit 127 forever and locks the gateway out of repairing it, because unlink
  // permission comes from the parent. Losing Composio drops the composio
  // server from the projection; it does not delete the projection.
  const endpoint = rawEndpoint ? validateEndpoint(rawEndpoint) : null;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  // The projection carries every MCP server the container should have, keyed by
  // name. Secrets live here — a tmpfs file mounted read-only — and never in the
  // tenant's canonical openclaw.json, which `tenantHasCanonicalPlaintextMcp`
  // exists to keep clean.
  const servers = {};
  if (endpoint) servers.composio = endpoint;
  const agent = await rockyAgentServer(tenant.id);
  if (agent) servers.rocky = agent;

  const projectionPath = composioRuntimeProjectionPath(tenant.id);
  const rewrote = await writeIfChanged(projectionPath, `${JSON.stringify({ servers })}\n`);
  const hash = mcpServersHash(servers);
  if (rewrote) {
    console.log(
      `[mcp] ${tenant.id}: projection changed (${Object.keys(servers).sort().join(',')}) hash=${hash}`,
    );
  }

  const canonical = JSON.parse(await fs.readFile(canonicalConfigPath, 'utf8'));
  const runtime = {
    ...canonical,
    mcp: {
      ...(canonical.mcp || {}),
      servers: {
        ...((canonical.mcp && canonical.mcp.servers) || {}),
        ...Object.fromEntries(
          Object.entries(servers).map(([name, e]) => [
            name,
            { transport: 'streamable-http', url: e.url, ...(e.headers ? { headers: e.headers } : {}) },
          ]),
        ),
      },
    },
  };
  const configPath = composioRuntimeConfigPath(tenant.id);
  await writeIfChanged(configPath, `${JSON.stringify(runtime, null, 2)}\n`);
  return { configPath, projectionPath, serversHash: hash, rewrote };
}

export async function clearTenantComposioRuntime(tenantId) {
  await fs.rm(runtimeDirectory(tenantId), { recursive: true, force: true });
}

export function tenantHasCanonicalPlaintextMcp(tenantId) {
  const canonical = path.join(tenantDir(tenantId), 'openclaw', 'openclaw.json');
  return fs.readFile(canonical, 'utf8')
    .then((raw) => Boolean(JSON.parse(raw)?.mcp?.servers?.composio))
    .catch(() => false);
}
