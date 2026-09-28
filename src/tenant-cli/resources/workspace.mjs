import { loadTenant, saveTenant } from '../../tenants.mjs';
import { verifyOrgBundle } from '../../mcp/org-bundle.mjs';

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

export async function handleResourceAction(request) {
  const tenant = await tenantFor(request);
  if (request.action === 'verify') {
    const verification = await verifyOrgBundle();
    return {
      tenantId: tenant.id,
      mutating: false,
      result: {
        ...verification,
        tenantOrgVersion: tenant.orgBundleVersion || null,
        current: tenant.orgBundleVersion === verification.version,
      },
    };
  }
  if (request.action === 'sync-org') {
    const verification = await verifyOrgBundle();
    if (!verification.ok) throw new Error(`Organization bundle verification failed: ${verification.errors.join('; ')}`);
    tenant.orgBundleVersion = verification.version;
    tenant.updatedAt = new Date().toISOString();
    await saveTenant(tenant);
    return {
      tenantId: tenant.id,
      mutating: true,
      result: { synced: true, orgBundleVersion: verification.version },
    };
  }
  throw new Error(`Unsupported workspace action: ${request.action || '<empty>'}`);
}
