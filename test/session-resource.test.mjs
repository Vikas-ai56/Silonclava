import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getResourceDefinition } from '../src/tenant-cli/registry.mjs';
import { authorizeTenantRequest } from '../src/tenant-cli/authorization.mjs';

const definition = getResourceDefinition('session');

function authorize(action, authorization, target = {}) {
  return authorizeTenantRequest(definition, {
    resource: 'session',
    action,
    target,
    params: {},
    authorization,
  });
}

test('session control goes through the grant model like every other capability', async (t) => {
  const agent = { kind: 'agent', tenantId: 'br_aaaaaaaaaaaa', principal: 'agent:br_aaaaaaaaaaaa' };

  await t.test('the agent may start and inspect its own session', () => {
    assert.equal(authorize('new', agent).target.tenantId, 'br_aaaaaaaaaaaa');
    assert.equal(authorize('show', agent).target.tenantId, 'br_aaaaaaaaaaaa');
  });

  await t.test('an action outside agentActions is refused', () => {
    assert.throws(() => authorize('delete', agent), /does not permit session delete/);
  });

  await t.test('the agent cannot act on another tenant', () => {
    assert.throws(
      () => authorize('new', agent, { tenantId: 'br_bbbbbbbbbbbb' }),
      /not authorized for tenant br_bbbbbbbbbbbb/i,
    );
  });

  await t.test('a plain tenant grant cannot reach it at all', () => {
    assert.throws(
      () => authorize('new', { kind: 'tenant', tenantId: 'br_aaaaaaaaaaaa' }),
      /Not authorized for session new/,
    );
  });

  await t.test('the operator must name a tenant', () => {
    assert.throws(() => authorize('new', { kind: 'operator' }), /Missing required tenant target/);
  });
});

test('the MCP tool is a passthrough, not a second implementation', async (t) => {
  const src = fs.readFileSync('src/agent-mcp.mjs', 'utf8');

  await t.test('it no longer calls startNewSession directly', () => {
    assert.doesNotMatch(src, /startNewSession/);
    assert.match(src, /client\.session\(\)\.new\(\)/);
  });

  await t.test('startNewSession stays the only writer of sessionEpoch', () => {
    const writers = fs.readdirSync('src', { recursive: true })
      .filter((f) => String(f).endsWith('.mjs'))
      .filter((f) => /sessionEpoch:/.test(fs.readFileSync(`src/${f}`, 'utf8')));
    assert.deepEqual(writers, ['tenant-session.mjs']);
  });
});
