import { resolveOpenclawRunContext, runOpenclawTurn } from '../../openclaw/tenant-openclaw.mjs';
import {
  ensureTenantGateway,
  recycleTenantGateway,
  stopTenantGateway,
  warmGatewayStats,
} from '../../openclaw/tenant-gateway.mjs';
import { loadTenant } from '../../tenants.mjs';

async function tenantFromRequest(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

export function publicGatewayResult(gateway = {}) {
  const { token: _token, ...safe } = gateway;
  return { running: true, ...safe };
}

export async function handleResourceAction(request) {
  const { action } = request;
  const tenant = await tenantFromRequest(request);
  if (action === 'status') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: warmGatewayStats()[tenant.id] || { running: false },
    };
  }
  if (action === 'turn') {
    const text = String(request.params.text || '').trim();
    if (!text) throw new Error('runtime turn requires message text');
    const reply = await runOpenclawTurn(tenant, text);
    return {
      tenantId: tenant.id,
      mutating: false,
      audit: true,
      auditParams: { message: '[REDACTED]' },
      auditResult: { completed: true },
      result: { reply },
    };
  }
  if (action === 'start') {
    const ctx = await resolveOpenclawRunContext(tenant);
    const gateway = await ensureTenantGateway(tenant, ctx);
    return {
      tenantId: tenant.id,
      mutating: true,
      result: publicGatewayResult(gateway),
    };
  }
  if (action === 'stop') {
    await stopTenantGateway(tenant.id);
    return { tenantId: tenant.id, mutating: true, result: { stopped: true } };
  }
  if (action === 'recycle') {
    await recycleTenantGateway(tenant.id);
    return { tenantId: tenant.id, mutating: true, result: { recycled: true } };
  }
  throw new Error(`Unsupported runtime action: ${action || '<empty>'}`);
}
