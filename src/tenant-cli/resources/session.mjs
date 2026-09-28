import { loadTenant } from '../../tenants.mjs';
import { startNewSession } from '../../tenant-session.mjs';

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

export async function handleResourceAction(request) {
  const tenant = await tenantFor(request);

  if (request.action === 'new') {
    const { epoch, fromSequence } = await startNewSession(tenant.id);
    return {
      tenantId: tenant.id,
      mutating: true,
      result: { started: true, session: epoch, fromSequence },
    };
  }
  if (request.action === 'show') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: {
        session: Number(tenant.sessionEpoch || 0),
        fromSequence: Number(tenant.sessionFromSequence || 0),
      },
    };
  }
  throw new Error(`Unsupported session action: ${request.action || '<empty>'}`);
}
