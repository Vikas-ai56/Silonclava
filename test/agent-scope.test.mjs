import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTenantRequest } from '../src/tenant-cli/authorization.mjs';
import { getResourceDefinition } from '../src/tenant-cli/registry.mjs';

/**
 * The agent grant is what a model — driven by untrusted WhatsApp input — runs
 * tenant commands under. Its safety property is structural: a resource that
 * declares no `agentActions` is unreachable, so nothing is protected by a
 * denylist anyone has to remember to update.
 */
const agent = (tenantId = 'br_aaaaaaaaaaaa') => ({ kind: 'agent', tenantId });

function attempt(resource, action, authorization, target = undefined) {
  const definition = getResourceDefinition(resource);
  return () => authorizeTenantRequest(definition, { resource, action, authorization, target, params: {} });
}

describe('agent grant scope', () => {
  it('permits exactly the MCP actions a user could ask for in conversation', () => {
    for (const action of ['available', 'tools', 'list', 'status', 'connect']) {
      const out = attempt('mcp', action, agent())();
      assert.equal(out.target.tenantId, 'br_aaaaaaaaaaaa');
    }
  });

  it('refuses disconnect — destructive and only the user can undo it', () => {
    assert.throws(attempt('mcp', 'disconnect', agent()), /does not permit mcp disconnect/);
  });

  it('cannot reach the credential control plane or tenant lifecycle', () => {
    for (const [resource, action] of [
      ['vault', 'get'], ['vault', 'set'],
      ['auth', 'login'], ['auth', 'logout'],
      ['user', 'list'], ['route', 'set'],
      ['org', 'build'], ['turn', 'list'],
    ]) {
      assert.throws(
        attempt(resource, action, agent()),
        /does not permit|Not authorized/,
        `${resource} ${action} must be unreachable`,
      );
    }
  });

  it('cannot act on another tenant even by asking', () => {
    assert.throws(
      attempt('mcp', 'list', agent('br_aaaaaaaaaaaa'), { tenantId: 'br_bbbbbbbbbbbb' }),
      /not authorized for tenant br_bbbbbbbbbbbb/i,
    );
  });

  it('refuses a grant with no tenant id', () => {
    assert.throws(attempt('mcp', 'list', { kind: 'agent' }), /missing a tenant id/i);
  });

  it('is default-deny: a resource that declares no agentActions is unreachable', () => {
    const definition = { id: 'made-up' };
    assert.throws(
      () => authorizeTenantRequest(definition, {
        resource: 'made-up', action: 'anything', authorization: agent(), params: {},
      }),
      /does not permit/,
    );
  });
});
