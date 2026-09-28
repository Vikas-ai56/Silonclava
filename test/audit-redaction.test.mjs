import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactParams } from '../src/tenant-cli/audit.mjs';

describe('redaction hides secrets without hiding the answer', () => {
  it('still redacts a real endpoint and its headers', () => {
    const out = redactParams({
      endpoint: { url: 'https://backend.composio.dev/s/opaque', headers: { 'x-api-key': 'k' } },
    });
    assert.equal(out.endpoint, '[REDACTED]');
  });

  it('does not redact a boolean that merely mentions endpoint', () => {
    const out = redactParams({ endpointReady: true, storedEndpoint: false });
    assert.equal(out.endpointReady, true,
      'this is the one field telling an operator whether an MCP endpoint was produced; '
      + 'redacting a boolean hides the result and reveals nothing');
    assert.equal(out.storedEndpoint, false);
  });

  it('keeps redacting the things that are actually secret', () => {
    const out = redactParams({
      token: 'abc', apiKey: 'abc', password: 'abc', authorization: 'Bearer x',
      connectLink: 'https://connect', headers: { a: 1 }, code: '123456',
    });
    for (const k of ['token', 'apiKey', 'password', 'authorization', 'connectLink', 'headers', 'code']) {
      assert.equal(out[k], '[REDACTED]', `${k} must stay redacted`);
    }
  });
});
