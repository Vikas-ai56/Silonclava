import crypto from 'node:crypto';
import { CONNECTOR_SIDECAR_URL } from '../../../config.mjs';
import { loadComposioPlatformCredentials } from './credentials.mjs';
import { createConnectorAssertion } from './identity.mjs';

function safeMessage(status, payload) {
  const message = payload?.error?.message;
  if (typeof message === 'string' && message.length <= 300) return message;
  return `Connector sidecar request failed (${status})`;
}

function connectorBaseUrl() {
  const url = new URL(CONNECTOR_SIDECAR_URL);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('ROCKY_CONNECTOR_SIDECAR_URL must be an unauthenticated loopback HTTP URL');
  }
  return url.toString().replace(/\/$/, '');
}

async function request(tenantId, pathname, { method = 'GET', body, idempotencyKey } = {}) {
  const credentials = await loadComposioPlatformCredentials();
  const assertion = createConnectorAssertion(tenantId, credentials.assertionPrivateKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${connectorBaseUrl()}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${assertion}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(safeMessage(response.status, payload));
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Connector sidecar timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createComposioSidecarClient(tenantId) {
  const boundTenant = String(tenantId || '');
  if (!boundTenant) throw new Error('Composio client requires a server-resolved tenant id');
  return Object.freeze({
    available: () => request(boundTenant, '/api/v1/toolkits'),
    tools: (toolkit) => request(boundTenant, `/api/v1/toolkits/${encodeURIComponent(toolkit)}/tools`),
    connections: () => request(boundTenant, '/api/v1/connections'),
    connect: (toolkit) => request(
      boundTenant,
      `/api/v1/toolkits/${encodeURIComponent(toolkit)}/connections`,
      { method: 'POST', idempotencyKey: crypto.randomUUID() },
    ),
    disconnect: (toolkit, connectionId = null) => request(
      boundTenant,
      `/api/v1/toolkits/${encodeURIComponent(toolkit)}/connections`
      + (connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ''),
      { method: 'DELETE' },
    ),
    resolve: (toolkits) => request(
      boundTenant,
      '/api/v1/mcp/resolve',
      { method: 'POST', body: { toolkits } },
    ),
  });
}
