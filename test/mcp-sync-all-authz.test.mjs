import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getResourceDefinition } from '../src/tenant-cli/registry.mjs';
import { authorizeTenantRequest } from '../src/tenant-cli/authorization.mjs';

const mcp = getResourceDefinition('mcp');

function authorize(action, authorization, params = {}) {
  return authorizeTenantRequest(mcp, {
    resource: 'mcp', action, target: {}, params, authorization,
  });
}

test('a platform-wide sync cannot be reached from a tenant grant', async (t) => {
  const tenant = { kind: 'tenant', tenantId: 'br_aaaaaaaaaaaa', principal: 'whatsapp:br_aaaaaaaaaaaa' };

  await t.test('sync-all is its own action, absent from tenantActions', () => {
    assert.equal(mcp.tenantActions.has('sync'), true);
    assert.equal(mcp.tenantActions.has('sync-all'), false);
    assert.throws(() => authorize('sync-all', tenant), /Not authorized for mcp sync-all/);
  });

  await t.test('the agent grant cannot reach it either', () => {
    assert.equal(mcp.agentActions.has('sync-all'), false);
    assert.throws(
      () => authorize('sync-all', { kind: 'agent', tenantId: 'br_aaaaaaaaaaaa' }),
      /does not permit mcp sync-all/,
    );
  });

  await t.test('the operator can', () => {
    assert.doesNotThrow(() => authorize('sync-all', { kind: 'operator' }));
  });

  // The fan-out used to be `action === 'sync' && params.all`, evaluated BEFORE
  // tenant resolution. `sync` is tenant-reachable and the tenant client forwards
  // caller params verbatim, so a param decided the blast radius of an action the
  // grant model had already allowed.
  await t.test('no params-driven branch decides platform scope', () => {
    const src = fs.readFileSync('src/tenant-cli/resources/mcp.mjs', 'utf8');
    assert.doesNotMatch(src, /action === 'sync' && params\.all/);
    assert.match(src, /action === 'sync-all'/);
  });
});
