import { appendPlatformAudit, appendTenantAudit } from './audit.mjs';
import { auditActor, authorizeTenantRequest } from './authorization.mjs';
import { getResourceDefinition, listResources } from './registry.mjs';

function normalizeRequest(request = {}) {
  const resource = String(request.resource || '').toLowerCase();
  const action = String(request.action || '').toLowerCase();
  if (!resource) {
    throw new Error(
      `Missing tenant command resource. Known resources: ${listResources().join(', ')}`,
    );
  }
  if (!action) throw new Error('Missing tenant command action');
  return {
    resource,
    action,
    target: request.target || {},
    params: request.params || {},
    authorization: request.authorization || null,
    transport: request.transport || { kind: 'internal' },
  };
}

export async function executeTenantRequest(input) {
  const normalized = normalizeRequest(input);
  const definition = getResourceDefinition(normalized.resource);
  const request = authorizeTenantRequest(definition, normalized);
  const resourceModule = await definition.load();
  const outcome = await resourceModule.handleResourceAction(request);
  const envelope = {
    ok: true,
    resource: request.resource,
    action: request.action,
    tenantId: outcome.tenantId || request.target?.tenantId || null,
    result: outcome.result,
  };

  if (outcome.mutating || outcome.audit) {
    const tenantIds = new Set([
      outcome.tenantId,
      request.target?.tenantId,
      ...(outcome.auditTenantIds || []),
    ].filter(Boolean));
    for (const tenantId of tenantIds) {
      await appendTenantAudit({
        tenantId,
        actor: auditActor(request.authorization),
        resource: request.resource,
        action: request.action,
        params: outcome.auditParams || request.params,
        result: outcome.auditResult || outcome.result,
      });
    }
    if (outcome.auditScope === 'platform') {
      await appendPlatformAudit({
        actor: auditActor(request.authorization),
        resource: request.resource,
        action: request.action,
        params: outcome.auditParams || request.params,
        result: outcome.auditResult || outcome.result,
      });
    }
  }
  return envelope;
}
