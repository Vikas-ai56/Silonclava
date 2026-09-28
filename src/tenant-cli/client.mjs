import { executeTenantRequest } from './command.mjs';
import { getProviderDefinition } from './registry.mjs';

function tenantRequest(grant, resource, action, provider, params = {}, transport = { kind: 'internal' }) {
  return executeTenantRequest({
    resource,
    action,
    target: { tenantId: grant.tenantId },
    params: { ...params, provider },
    authorization: grant,
    transport,
  });
}

export function createTenantClient({ tenantId, principal } = {}) {
  const grant = {
    kind: 'tenant',
    tenantId: String(tenantId || ''),
    principal: principal || `tenant:${tenantId}`,
  };
  if (!grant.tenantId) throw new Error('Tenant client requires a server-resolved tenant id');
  return {
    auth(provider = 'claude') {
      getProviderDefinition(provider, { resource: 'auth' });
      return {
        login: (params = {}) => tenantRequest(grant, 'auth', 'login', provider, params),
        complete: (params = {}) => tenantRequest(grant, 'auth', 'complete', provider, params),
        status: () => tenantRequest(grant, 'auth', 'status', provider),
        logout: () => tenantRequest(grant, 'auth', 'logout', provider),
        canComplete: (raw) => tenantRequest(grant, 'auth', 'can-complete', provider, { raw }),
      };
    },
    mcp() {
      return {
        available: (params = {}) => tenantRequest(grant, 'mcp', 'available', null, params),
        tools: (toolkit) => tenantRequest(grant, 'mcp', 'tools', null, { toolkit }),
        list: () => tenantRequest(grant, 'mcp', 'list', null),
        status: (toolkit = null) => tenantRequest(
          grant,
          'mcp',
          'status',
          null,
          toolkit ? { toolkit } : {},
        ),
        connect: (toolkit) => tenantRequest(grant, 'mcp', 'connect', null, { toolkit }),
        disconnect: (toolkit) => tenantRequest(grant, 'mcp', 'disconnect', null, { toolkit }),
        sync: (params = {}) => tenantRequest(grant, 'mcp', 'sync', null, params),
        doctor: () => tenantRequest(grant, 'mcp', 'doctor', null),
      };
    },
    workspace() {
      return {
        verify: () => tenantRequest(grant, 'workspace', 'verify', null),
      };
    },
    runtime() {
      return {
        status: () => tenantRequest(grant, 'runtime', 'status', null),
        turn: (text) => tenantRequest(grant, 'runtime', 'turn', null, { text }),
      };
    },
  };
}

/**
 * The grant the model acts under. Deliberately thin: it exposes only what a
 * user could ask for in conversation — see what is connected, and start a
 * connection — so that natural phrasing works without the agent holding
 * anything it could not explain to the person it is talking to.
 */
export function createTenantAgentClient({ tenantId } = {}) {
  const grant = {
    kind: 'agent',
    tenantId: String(tenantId || ''),
    principal: `agent:${tenantId}`,
  };
  if (!grant.tenantId) throw new Error('Agent client requires a server-resolved tenant id');
  return Object.freeze({
    session: () => Object.freeze({
      new: () => tenantRequest(grant, 'session', 'new', null),
      show: () => tenantRequest(grant, 'session', 'show', null),
    }),
    mcp: () => Object.freeze({
      available: (params = {}) => tenantRequest(grant, 'mcp', 'available', null, params),
      tools: (toolkit) => tenantRequest(grant, 'mcp', 'tools', null, { toolkit }),
      list: () => tenantRequest(grant, 'mcp', 'list', null),
      status: (toolkit = null) => tenantRequest(grant, 'mcp', 'status', null, toolkit ? { toolkit } : {}),
      connect: (toolkit) => tenantRequest(grant, 'mcp', 'connect', null, { toolkit }),
    }),
    voice: () => Object.freeze({
      call: (task) => tenantRequest(grant, 'voice', 'call', null, { task }),
      status: (call) => tenantRequest(grant, 'voice', 'status', null, { call }),
      list: () => tenantRequest(grant, 'voice', 'list', null),
    }),
    cron: () => Object.freeze({
      list: () => tenantRequest(grant, 'cron', 'list', null),
      create: (spec) => tenantRequest(grant, 'cron', 'create', null, spec),
      remove: (job) => tenantRequest(grant, 'cron', 'remove', null, { job }),
    }),
  });
}

export function createTenantRuntimeClient({ tenantId } = {}) {
  const grant = {
    kind: 'runtime',
    tenantId: String(tenantId || ''),
    principal: `runtime:${tenantId}`,
  };
  if (!grant.tenantId) throw new Error('Runtime client requires a server-resolved tenant id');
  return Object.freeze({
    hydrateMcp: (canonicalConfigPath) => tenantRequest(
      grant,
      'mcp',
      'hydrate',
      null,
      { canonicalConfigPath },
    ),
  });
}

async function inspectProviderCallback(provider, state) {
  const definition = getProviderDefinition(provider);
  if (!definition.supportsBrowserCallback) throw new Error(`${provider} does not support browser callbacks`);
  const module = await definition.load();
  const inspect = module.inspectClaudeCallbackState;
  if (typeof inspect !== 'function') throw new Error(`${provider} callback inspection is unavailable`);
  const session = inspect(state);
  if (!session) throw new Error(`Invalid or expired ${provider} login state`);
  return { definition, session };
}

export async function inspectOAuthCallback(provider, state) {
  const { session } = await inspectProviderCallback(provider, state);
  return {
    tenantId: session.tenantId,
    replyJid: session.replyJid || null,
    authorizeUrl: session.authorizeUrl || null,
    state: session.oauthState || session.state,
  };
}

export async function completeOAuthCallback(provider, { state, code } = {}) {
  const callbackState = String(state || '').trim();
  const callbackCode = String(code || '').trim();
  if (!callbackState || !callbackCode) {
    throw new Error('OAuth callback requires both code and state');
  }
  const { definition, session } = await inspectProviderCallback(provider, callbackState);
  const authorization = {
    kind: 'oauth-callback',
    tenantId: session.tenantId,
    provider: definition.id,
    principal: `oauth-callback:${definition.id}`,
  };
  return executeTenantRequest({
    resource: definition.resource,
    action: 'complete',
    target: { tenantId: session.tenantId },
    params: {
      provider: definition.id,
      state: callbackState,
      code: callbackCode.includes('#') ? callbackCode : `${callbackCode}#${callbackState}`,
    },
    authorization,
    transport: { kind: 'oauth-callback' },
  });
}
