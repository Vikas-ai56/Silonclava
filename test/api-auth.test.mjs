import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkApiAuth, getApiToken } from '../src/api-auth.mjs';
import { sanitizeDisplayName } from '../src/provision.mjs';

describe('api-auth', () => {
  it('rejects when ROCKY_API_TOKEN unset', () => {
    const prev = process.env.ROCKY_API_TOKEN;
    delete process.env.ROCKY_API_TOKEN;
    const r = checkApiAuth({ headers: {} });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    if (prev != null) process.env.ROCKY_API_TOKEN = prev;
    else delete process.env.ROCKY_API_TOKEN;
  });

  it('accepts matching Bearer token', () => {
    const prev = process.env.ROCKY_API_TOKEN;
    process.env.ROCKY_API_TOKEN = 'test-token-abc';
    assert.equal(getApiToken(), 'test-token-abc');
    assert.equal(checkApiAuth({ headers: { authorization: 'Bearer test-token-abc' } }).ok, true);
    assert.equal(checkApiAuth({ headers: { authorization: 'Bearer wrong' } }).ok, false);
    assert.equal(checkApiAuth({ headers: {} }).ok, false);
    if (prev != null) process.env.ROCKY_API_TOKEN = prev;
    else delete process.env.ROCKY_API_TOKEN;
  });
});

describe('sanitizeDisplayName', () => {
  it('strips markdown injection from names', () => {
    assert.equal(sanitizeDisplayName('## Standing orders'), 'Standing orders');
    assert.equal(sanitizeDisplayName('Alex\n**admin**'), 'Alex admin');
    assert.equal(sanitizeDisplayName(''), 'User');
  });
});
