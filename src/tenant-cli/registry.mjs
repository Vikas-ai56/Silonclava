const RESOURCE_DEFINITIONS = new Map([
  ['auth', {
    id: 'auth',
    tenantSelfService: true,
    requiresTenant: true,
    load: () => import('./resources/auth.mjs'),
  }],
  ['state', {
    id: 'state',
    // Operator only: absent from the tenant-bound client, WhatsApp intents, MCP
    // tools, OpenClaw config and the container image (SPEC-phase3c §9).
    tenantSelfService: false,
    requiresTenant: true,
    load: () => import('./resources/state.mjs'),
  }],
  ['turn', {
    id: 'turn',
    tenantSelfService: false,
    requiresTenant: true,
    load: () => import('./resources/turn.mjs'),
  }],
  ['vault', {
    id: 'vault',
    tenantSelfService: false,
    requiresTenant: true,
    load: () => import('./resources/vault.mjs'),
  }],
  ['mcp', {
    id: 'mcp',
    tenantSelfService: true,
    tenantActions: new Set([
      'available', 'tools', 'list', 'status', 'connect', 'disconnect', 'sync', 'doctor',
    ]),
    runtimeActions: new Set(['hydrate']),
    // What the model itself may invoke. `disconnect` is deliberately absent:
    // it is destructive and recoverable only by the user re-authorising in a
    // browser, which an agent cannot do on their behalf. Nothing here can
    // reach another tenant — the grant carries the tenant id.
    agentActions: new Set(['available', 'tools', 'list', 'status', 'connect']),
    requiresTenant: false,
    load: () => import('./resources/mcp.mjs'),
  }],
  ['cron', {
    id: 'cron',
    tenantSelfService: true,
    tenantActions: new Set(['list', 'create', 'remove']),
    agentActions: new Set(['list', 'create', 'remove']),
    requiresTenant: true,
    load: () => import('./resources/cron.mjs'),
  }],
  ['voice', {
    id: 'voice',
    tenantSelfService: false,
    agentActions: new Set(['call', 'status', 'list']),
    requiresTenant: true,
    load: () => import('./resources/voice.mjs'),
  }],
  ['org', {
    id: 'org',
    tenantSelfService: false,
    requiresTenant: false,
    load: () => import('./resources/org.mjs'),
  }],
  ['workspace', {
    id: 'workspace',
    tenantSelfService: true,
    tenantActions: new Set(['verify']),
    requiresTenant: true,
    load: () => import('./resources/workspace.mjs'),
  }],
  ['runtime', {
    id: 'runtime',
    tenantSelfService: true,
    tenantActions: new Set(['status', 'turn']),
    requiresTenant: true,
    load: () => import('./resources/runtime.mjs'),
  }],
  ['session', {
    id: 'session',
    tenantSelfService: false,
    agentActions: new Set(['new', 'show']),
    requiresTenant: true,
    load: () => import('./resources/session.mjs'),
  }],
  ['route', {
    id: 'route',
    tenantSelfService: false,
    requiresTenant: true,
    load: () => import('./resources/route.mjs'),
  }],
  ['user', {
    id: 'user',
    tenantSelfService: false,
    requiresTenant: false,
    load: () => import('./resources/user.mjs'),
  }],
]);

const PROVIDER_DEFINITIONS = new Map([
  ['claude', {
    id: 'claude',
    resource: 'auth',
    actions: new Set(['login', 'complete', 'status', 'logout', 'can-complete']),
    terminalActions: new Set(['login', 'complete', 'status', 'logout']),
    credentialOwner: 'native-claude-cli',
    storageKind: 'claude-cli-home',
    supportsBrowserCallback: true,
    supportsExplicitRefresh: false,
    supportsRemoteRevoke: false,
    load: () => import('./providers/claude/index.mjs'),
  }],
]);

const ROUTE_BACKENDS = new Map([
  ['hermes', {
    id: 'hermes',
    status: 'retiring',
    rollbackEligible: true,
  }],
  ['openclaw', {
    id: 'openclaw',
    status: 'active',
    rollbackEligible: true,
  }],
]);

export const DEFAULT_ROUTE_BACKEND = 'hermes';

/** Resource names, for usage messages and discovery. */
export function listResources() {
  return [...RESOURCE_DEFINITIONS.keys()].sort();
}

export function getResourceDefinition(resource) {
  const definition = RESOURCE_DEFINITIONS.get(String(resource || '').toLowerCase());
  if (!definition) throw new Error(`Unsupported resource: ${resource || '<empty>'}`);
  return definition;
}

export function getProviderDefinition(provider, { resource, action, transportKind } = {}) {
  const definition = PROVIDER_DEFINITIONS.get(String(provider || '').toLowerCase());
  if (!definition || (resource && definition.resource !== resource)) {
    throw new Error(`Unsupported ${resource || 'credential'} provider: ${provider || '<empty>'}`);
  }
  if (action && !definition.actions.has(action)) {
    throw new Error(`Unsupported ${resource} action for ${definition.id}: ${action || '<empty>'}`);
  }
  if (transportKind === 'terminal' && action && !definition.terminalActions.has(action)) {
    throw new Error(`${resource} ${action} is not available from the terminal adapter`);
  }
  return definition;
}

export function getRouteBackend(backend) {
  const definition = ROUTE_BACKENDS.get(String(backend || '').toLowerCase());
  if (!definition) {
    throw new Error(`Unknown route backend: ${backend || '<empty>'}`);
  }
  return definition;
}

export function listRouteBackends() {
  return [...ROUTE_BACKENDS.values()].map((entry) => ({ ...entry }));
}
