import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ROOT,
  TENANTS_DIR,
  TEMPLATE_WORKSPACE,
  PUBLIC_DIR,
  PLATFORM_DIR,
} from '../src/paths.mjs';
import {
  isOperatorPhone,
  isAllowedPhone,
  OPERATOR_PHONES,
  ALLOWED_PHONES,
  sessionIdleTtlFor,
  SESSION_IDLE_TTL_MS,
  OPERATOR_SESSION_IDLE_TTL_MS,
  CONNECTOR_SIDECAR_URL,
  PUBLIC_BASE_URL,
} from '../src/config.mjs';
import { loadEnvFile, loadLocalEnv } from '../src/load-env.mjs';

describe('paths + config', () => {
  it('resolves project roots', () => {
    assert.ok(ROOT);
    assert.equal(TENANTS_DIR, path.resolve(process.env.ROCKY_TENANTS_DIR || path.join(ROOT, 'tenants')));
    assert.ok(TEMPLATE_WORKSPACE.endsWith(path.join('templates', 'workspace')));
    assert.ok(PUBLIC_DIR.endsWith('public'));
    assert.ok(PLATFORM_DIR);
  });

  it('operator phones and idle TTLs', () => {
    const sample = [...OPERATOR_PHONES][0];
    if (sample) {
      assert.equal(isOperatorPhone(sample), true);
      assert.equal(isOperatorPhone(`${sample}@s.whatsapp.net`), true);
      // Short digit must NOT privilege-escalate via endsWith
      if (sample.length >= 2) {
        assert.equal(isOperatorPhone(sample.slice(-1)), false);
      }
    }
    assert.equal(isOperatorPhone('15550009999'), false);
    assert.equal(isOperatorPhone('7'), false);
    assert.equal(sessionIdleTtlFor({ phone: '15550009999' }), SESSION_IDLE_TTL_MS);
    assert.equal(sessionIdleTtlFor({ role: 'operator', phone: '1' }), OPERATOR_SESSION_IDLE_TTL_MS);
    assert.ok(PUBLIC_BASE_URL.length > 0);
    assert.match(CONNECTOR_SIDECAR_URL, /^http:\/\//);
  });

  it('allowlist gates strangers when configured', () => {
    if (ALLOWED_PHONES.size === 0) {
      assert.equal(isAllowedPhone('15559998877'), true);
      return;
    }
    const sample = [...ALLOWED_PHONES][0];
    assert.equal(isAllowedPhone(sample), true);
    assert.equal(isAllowedPhone('15559998877'), false);
    if (sample.length >= 2) {
      assert.equal(isAllowedPhone(sample.slice(-1)), false);
    }
  });

  it('loadEnvFile is idempotent / safe on missing file', () => {
    assert.equal(loadEnvFile(path.join(ROOT, '.env.does-not-exist')), false);
  });

  it('loadLocalEnv finds .env.local or reports missing safely', () => {
    assert.equal(typeof loadLocalEnv(), 'boolean');
  });
});
