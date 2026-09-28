import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, handleAgentMcpRequest, tokenMatches, bearerToken } from '../src/agent-mcp.mjs';

const resolve = (tok) => (tok === 'good-token' ? 'br_aaaaaaaaaaaa' : null);
const call = (message, authorization = 'Bearer good-token') =>
  handleAgentMcpRequest({ message, authorization, resolveTenant: resolve });

describe('agent MCP transport', () => {
  it('refuses a request with no or wrong credential', async () => {
    assert.equal((await call({ method: 'tools/list', id: 1 }, '')).status, 401);
    assert.equal((await call({ method: 'tools/list', id: 1 }, 'Bearer nope')).status, 401);
  });

  it('compares tokens in constant time and rejects length mismatch', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abcd'), false);
    assert.equal(tokenMatches('', ''), false, 'an empty token must never match');
    assert.equal(bearerToken('Bearer xyz'), 'xyz');
    assert.equal(bearerToken('Basic xyz'), '');
  });

  it('completes the MCP handshake', async () => {
    const out = await call({ method: 'initialize', id: 1 });
    assert.equal(out.status, 200);
    assert.ok(out.body.result.protocolVersion);
    assert.deepEqual(out.body.result.capabilities, { tools: {} });
  });

  it('answers a notification with no body', async () => {
    const out = await call({ method: 'notifications/initialized' });
    assert.equal(out.status, 202);
    assert.equal(out.body, null);
  });

  it('advertises the connect capability the regex used to own', async () => {
    const out = await call({ method: 'tools/list', id: 2 });
    const names = out.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('connect_account'));
    assert.ok(names.includes('list_connected_accounts'));
    for (const tool of out.body.result.tools) {
      assert.ok(tool.description?.length > 20, `${tool.name} needs a usable description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(!('run' in tool), 'the handler must not be serialised to the model');
    }
  });

  it('exposes nothing beyond the agent grant', async () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const forbidden of ['disconnect', 'vault', 'delete', 'route', 'tenant']) {
      assert.ok(!names.some((n) => n.includes(forbidden)), `no tool may expose ${forbidden}`);
    }
  });

  it('reports an unknown tool as a protocol error', async () => {
    const out = await call({ method: 'tools/call', id: 3, params: { name: 'rm_rf', arguments: {} } });
    assert.equal(out.body.error.code, -32602);
  });

  it('returns a refused capability as a tool result, not a transport failure', async () => {
    const out = await call({
      method: 'tools/call', id: 4,
      params: { name: 'connection_status', arguments: { toolkit: 'gmail' } },
    });
    assert.equal(out.status, 200, 'the model must be able to read the failure');
    assert.ok(out.body.result.isError || out.body.result.content, 'either way it is a result');
  });
});
