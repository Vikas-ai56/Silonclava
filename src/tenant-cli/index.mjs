import { parseTenantArgs } from './args.mjs';
import {
  completeOAuthCallback,
  createTenantClient,
  createTenantRuntimeClient,
  inspectOAuthCallback,
} from './client.mjs';
import { executeTenantRequest } from './command.mjs';

function paramsFromOptions(options) {
  const params = { ...options };
  delete params.tenant;
  delete params.json;
  if (params['reply-jid'] != null) {
    params.replyJid = params['reply-jid'];
    delete params['reply-jid'];
  }
  return params;
}

export async function executeTenantCommand(argv, context = {}) {
  const parsed = parseTenantArgs(argv);
  if (parsed.options.actor != null) {
    throw new Error('--actor is not accepted; audit identity comes from the authenticated caller');
  }
  return executeTenantRequest({
    resource: parsed.resource,
    action: parsed.action,
    target: parsed.options.tenant ? { tenantId: String(parsed.options.tenant) } : {},
    params: paramsFromOptions(parsed.options),
    authorization: context.authorization,
    transport: { kind: 'terminal' },
  });
}

export {
  completeOAuthCallback,
  createTenantClient,
  createTenantRuntimeClient,
  inspectOAuthCallback,
};
