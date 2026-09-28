import { buildOrgBundle, readOrgMcpRegistry, verifyOrgBundle } from '../../mcp/org-bundle.mjs';

export async function handleResourceAction(request) {
  if (request.action === 'validate') {
    const registry = await readOrgMcpRegistry();
    const verification = await verifyOrgBundle();
    return {
      mutating: false,
      result: {
        ...verification,
        provider: registry.provider,
        toolkits: Object.keys(registry.toolkits).sort(),
      },
    };
  }
  if (request.action === 'build') {
    const result = await buildOrgBundle(request.params.version);
    return { mutating: true, auditScope: 'platform', result };
  }
  throw new Error(`Unsupported org action: ${request.action || '<empty>'}`);
}
