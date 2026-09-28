export function auditActor(authorization) {
  const principal = String(authorization?.principal || '').trim();
  if (principal) return principal;
  if (authorization?.kind === 'tenant') return `tenant:${authorization.tenantId}`;
  if (authorization?.kind === 'agent') return `agent:${authorization.tenantId}`;
  if (authorization?.kind === 'oauth-callback') return `oauth-callback:${authorization.provider}`;
  return 'operator';
}

export function authorizeTenantRequest(definition, request) {
  const authorization = request.authorization || {};
  const explicitTarget = request.target?.tenantId ? String(request.target.tenantId) : null;

  if (authorization.kind === 'operator') {
    if (definition.requiresTenant && !explicitTarget) {
      throw new Error(`Missing required tenant target for ${request.resource} ${request.action}`);
    }
    return { ...request, target: explicitTarget ? { tenantId: explicitTarget } : {} };
  }

  if (authorization.kind === 'tenant' && definition.tenantSelfService) {
    const grantedTenant = String(authorization.tenantId || '');
    if (!grantedTenant) throw new Error('Tenant grant is missing a tenant id');
    if (explicitTarget && explicitTarget !== grantedTenant) {
      throw new Error(`Not authorized for ${request.resource} on tenant ${explicitTarget}`);
    }
    if (definition.tenantActions && !definition.tenantActions.has(request.action)) {
      throw new Error(`Not authorized for ${request.resource} ${request.action}`);
    }
    return { ...request, target: { tenantId: grantedTenant } };
  }

  if (authorization.kind === 'oauth-callback') {
    const grantedTenant = String(authorization.tenantId || '');
    const grantedProvider = String(authorization.provider || '');
    if (
      request.action !== 'complete' ||
      !grantedTenant ||
      explicitTarget !== grantedTenant ||
      String(request.params?.provider || '') !== grantedProvider
    ) {
      throw new Error('OAuth callback grant does not match this completion request');
    }
    return { ...request, target: { tenantId: grantedTenant } };
  }

  // The agent grant is what the model runs commands under. It is default-deny
  // by construction: a resource that declares no `agentActions` is unreachable,
  // so vault, user, route and tenant lifecycle are out of scope without anyone
  // maintaining a denylist. Adding a capability is a deliberate edit to that
  // resource's definition.
  if (authorization.kind === 'agent') {
    const grantedTenant = String(authorization.tenantId || '');
    if (!grantedTenant) throw new Error('Agent grant is missing a tenant id');
    if (explicitTarget && explicitTarget !== grantedTenant) {
      throw new Error(`Agent grant is not authorized for tenant ${explicitTarget}`);
    }
    if (!definition.agentActions?.has(request.action)) {
      throw new Error(`Agent grant does not permit ${request.resource} ${request.action}`);
    }
    return { ...request, target: { tenantId: grantedTenant } };
  }

  if (authorization.kind === 'runtime') {
    const grantedTenant = String(authorization.tenantId || '');
    if (
      !grantedTenant ||
      (explicitTarget && explicitTarget !== grantedTenant) ||
      !definition.runtimeActions?.has(request.action)
    ) {
      throw new Error('Runtime grant does not match this tenant command');
    }
    return { ...request, target: { tenantId: grantedTenant } };
  }

  throw new Error(
    `Not authorized for ${request.resource || '<resource>'} ${request.action || '<action>'}`,
  );
}
