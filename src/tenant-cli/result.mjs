import { redactParams } from './audit.mjs';

/** Terminal stdout receives a display-safe projection, never the internal result. */
export function projectTenantCommandForStdout(envelope) {
  if (
    (envelope?.resource === 'auth' && envelope?.action === 'login')
  ) {
    return {
      ok: envelope.ok === true,
      resource: envelope.resource,
      action: 'login',
      tenantId: envelope.tenantId || null,
      result: {
        provider: envelope.result?.provider || envelope.result?.server || null,
        started: true,
        message: `${envelope.result?.provider || envelope.result?.server || 'Provider'} login started. Continue in the tenant’s WhatsApp conversation.`,
      },
    };
  }
  if (envelope?.resource === 'mcp' && envelope?.action === 'connect') {
    return {
      ok: envelope.ok === true,
      resource: 'mcp',
      action: 'connect',
      tenantId: envelope.tenantId || null,
      result: {
        toolkit: envelope.result?.toolkit || null,
        connectionId: envelope.result?.connectionId || null,
        connectLink: envelope.result?.connectLink || null,
        message: envelope.result?.message || null,
      },
    };
  }
  return redactParams(envelope);
}
