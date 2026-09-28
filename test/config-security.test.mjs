import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importFreshConfig } from './helpers.mjs';

describe('security profile (fresh config)', () => {
  it('effectiveOpenclawRuntime forces docker in prod profile', async () => {
    const prod = await importFreshConfig({
      ROCKY_PROFILE: 'prod',
      ROCKY_OPENCLAW_RUNTIME: 'spawn',
    });
    assert.equal(prod.effectiveOpenclawRuntime(), 'docker');

    const dev = await importFreshConfig({
      ROCKY_PROFILE: 'dev',
      ROCKY_OPENCLAW_RUNTIME: 'spawn',
    });
    assert.equal(dev.effectiveOpenclawRuntime(), 'spawn');
  });

  it('validateStartupSecurity fails prod misconfiguration', async () => {
    const bad = await importFreshConfig({
      ROCKY_PROFILE: 'prod',
      ROCKY_OPENCLAW_RUNTIME: 'spawn',
      ROCKY_CLI_HOST_FALLBACK: '1',
      ROCKY_ALLOW_FROM: '',
      ROCKY_API_TOKEN: '',
    });
    const errors = bad.validateStartupSecurity();
    assert.ok(errors.length >= 2);
    assert.ok(errors.some((e) => /docker/i.test(e)));
    assert.ok(errors.some((e) => /CLI_HOST_FALLBACK/i.test(e)));
    if (bad.ALLOWED_PHONES.size === 0) {
      assert.ok(errors.some((e) => /ALLOW_FROM/i.test(e)));
    }
  });

  it('validateStartupSecurity passes prod when configured', async () => {
    await importFreshConfig(
      {
        ROCKY_PROFILE: 'prod',
        ROCKY_OPENCLAW_RUNTIME: 'docker',
        ROCKY_CLI_HOST_FALLBACK: '0',
        ROCKY_ALLOW_FROM: '15550001111',
        ROCKY_API_TOKEN: 'test-secret-token',
        ROCKY_INSTANCE_ID: 'sg1',
        ROCKY_VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      },
      (ok) => {
        assert.equal(ok.API_TOKEN, 'test-secret-token');
        assert.deepEqual(ok.validateStartupSecurity(), []);
      },
    );
  });

  it('rejects mock channel and a missing vault key in production', async () => {
    const cfg = await importFreshConfig({
      ROCKY_PROFILE: 'prod',
      ROCKY_OPENCLAW_RUNTIME: 'docker',
      ROCKY_CLI_HOST_FALLBACK: '0',
      ROCKY_ALLOW_FROM: '15550001111',
      ROCKY_API_TOKEN: 'test-secret-token',
      ROCKY_INSTANCE_ID: 'sg1',
      ROCKY_VAULT_MASTER_KEY: '',
    });
    const errors = cfg.validateStartupSecurity({ channelKind: 'mock' });
    assert.ok(errors.some((error) => /vault key/i.test(error)));
    assert.ok(errors.some((error) => /mock channel/i.test(error)));
  });

  it('canSignupPhone blocks unknown phones when allowlist set', async () => {
    const cfg = await importFreshConfig({
      ROCKY_PROFILE: 'dev',
      ROCKY_ALLOW_FROM: '15550001111',
    });
    assert.equal(cfg.canSignupPhone('15550001111'), true);
    assert.equal(cfg.canSignupPhone('15559998877'), false);
  });

  it('canUseHostCliFallback is operator-only in dev', async () => {
    const cfg = await importFreshConfig({
      ROCKY_PROFILE: 'dev',
      ROCKY_CLI_HOST_FALLBACK: '1',
      ROCKY_OPERATOR_PHONES: '15550001111',
    });
    assert.equal(cfg.canUseHostCliFallback({ phone: '15550001111', role: 'operator' }), true);
    assert.equal(cfg.canUseHostCliFallback({ phone: '15551234567' }), false);
    const prod = await importFreshConfig({
      ROCKY_PROFILE: 'prod',
      ROCKY_CLI_HOST_FALLBACK: '1',
      ROCKY_OPERATOR_PHONES: '15550001111',
    });
    assert.equal(prod.canUseHostCliFallback({ phone: '15550001111', role: 'operator' }), false);
  });
});
