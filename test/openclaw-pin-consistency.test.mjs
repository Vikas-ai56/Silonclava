import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { OPENCLAW_VERSION, OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';

/**
 * The pinned version lives in `src/config.mjs`, but the Dockerfile ARG and the
 * build script are consumed by `docker build` and cannot import it. This test
 * is what keeps those three in agreement.
 *
 * It exists because the version was previously duplicated across ten files.
 * That duplication is the reason a cron option was recorded in four documents
 * and shipped in code without ever being validated against the image it was
 * meant to configure.
 */
describe('pinned OpenClaw version consistency', () => {
  it('agrees across config, Dockerfile, and the build script', async () => {
    const dockerfile = await fs.readFile('Dockerfile.openclaw', 'utf8');
    const arg = dockerfile.match(/^ARG OPENCLAW_VERSION=(.+)$/m);
    assert.ok(arg, 'Dockerfile.openclaw must declare ARG OPENCLAW_VERSION');
    assert.equal(arg[1].trim(), OPENCLAW_VERSION);

    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const build = pkg.scripts['docker:build:openclaw'];
    assert.ok(
      build.includes(`rocky-openclaw:${OPENCLAW_VERSION}`),
      `build script tags a different image than OPENCLAW_VERSION (${OPENCLAW_VERSION}): ${build}`,
    );
    // Only the *default* is derived from OPENCLAW_VERSION. `ROCKY_OPENCLAW_IMAGE`
    // exists so a deployment can point at its own registry, so asserting the
    // effective image always equals the derived name would break exactly that.
    if (!process.env.ROCKY_OPENCLAW_IMAGE) {
      assert.equal(OPENCLAW_DOCKER_IMAGE, `rocky-openclaw:${OPENCLAW_VERSION}`);
    } else {
      assert.match(
        OPENCLAW_DOCKER_IMAGE,
        new RegExp(`${OPENCLAW_VERSION}$|^${process.env.ROCKY_OPENCLAW_IMAGE}$`),
        'an overridden image must still be the pinned version, or an explicit override',
      );
    }
  });

  it('refuses a spawn runtime that is not the pinned version', async () => {
    const { assertPinnedSpawnRuntime } = await import('../src/openclaw/tenant-openclaw.mjs');
    const saved = process.env.ROCKY_ALLOW_UNPINNED_OPENCLAW;
    delete process.env.ROCKY_ALLOW_UNPINNED_OPENCLAW;
    try {
      // The pin used to bind only the Docker image: the spawn path fell through
      // to whatever `openclaw` was on PATH and silently ran 2026.6.35 against a
      // 2026.7.1-2 pin. Everything verified about the pinned build says nothing
      // about an arbitrary PATH binary.
      let outcome;
      try {
        outcome = { ok: true, value: assertPinnedSpawnRuntime({ force: true }) };
      } catch (err) {
        outcome = { ok: false, message: err.message };
      }
      if (outcome.ok) {
        assert.equal(
          outcome.value.found,
          OPENCLAW_VERSION,
          'accepting a spawn runtime means it must be the pinned version',
        );
      } else {
        assert.match(outcome.message, /but the pin is/);
        assert.match(outcome.message, /ROCKY_OPENCLAW_BIN|ROCKY_ALLOW_UNPINNED_OPENCLAW/);
      }
    } finally {
      if (saved === undefined) delete process.env.ROCKY_ALLOW_UNPINNED_OPENCLAW;
      else process.env.ROCKY_ALLOW_UNPINNED_OPENCLAW = saved;
    }
  });

});
