import { loadTenant } from '../../tenants.mjs';
import { assertVaultMasterKey } from '../storage/vault-crypto.mjs';
import { getProviderDefinition } from '../registry.mjs';

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

export async function handleResourceAction(request) {
  const provider = String(request.params.provider || 'claude').toLowerCase();
  const definition = getProviderDefinition(provider, {
    resource: 'auth',
    action: request.action,
    transportKind: request.transport?.kind,
  });
  const module = await definition.load();
  const tenant = await tenantFor(request);
  if (request.action !== 'can-complete') assertVaultMasterKey();

  if (request.action === 'login') {
    return {
      tenantId: tenant.id,
      mutating: true,
      result: await module.beginClaudeLogin(tenant, request.params),
    };
  }
  if (request.action === 'complete') {
    if (!String(request.params.code || '').trim()) {
      throw new Error('Claude OAuth completion requires a code');
    }
    return {
      tenantId: tenant.id,
      mutating: true,
      result: await module.completeClaudeLogin(tenant, request.params.code),
    };
  }
  if (request.action === 'status') {
    return { tenantId: tenant.id, mutating: false, result: await module.claudeLoginStatus(tenant.id) };
  }
  if (request.action === 'logout') {
    return { tenantId: tenant.id, mutating: true, result: await module.logoutClaude(tenant.id) };
  }
  if (request.action === 'can-complete') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: { provider, pending: module.canCompleteClaudeLogin(tenant.id, request.params.raw) },
    };
  }
  throw new Error(`Unsupported auth action: ${request.action || '<empty>'}`);
}
