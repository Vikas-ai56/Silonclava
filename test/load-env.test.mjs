import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadEnvFile, loadLocalEnv } from '../src/load-env.mjs';
import { ROOT } from '../src/paths.mjs';

describe('load-env', () => {
  it('loadEnvFile parses KEY=VALUE without overriding existing env', async () => {
    const file = path.join(os.tmpdir(), `rocky-env-test-${process.pid}.env`);
    await fs.writeFile(file, 'ROCKY_LOAD_ENV_TEST=fromfile\n# comment\nEMPTY=\n', 'utf8');
    const prev = process.env.ROCKY_LOAD_ENV_TEST;
    delete process.env.ROCKY_LOAD_ENV_TEST;
    assert.equal(loadEnvFile(file), true);
    assert.equal(process.env.ROCKY_LOAD_ENV_TEST, 'fromfile');

    process.env.ROCKY_LOAD_ENV_TEST = 'preset';
    loadEnvFile(file);
    assert.equal(process.env.ROCKY_LOAD_ENV_TEST, 'preset');

    if (prev == null) delete process.env.ROCKY_LOAD_ENV_TEST;
    else process.env.ROCKY_LOAD_ENV_TEST = prev;
    await fs.rm(file, { force: true });
  });

  it('loadEnvFile returns false for missing file', () => {
    assert.equal(loadEnvFile(path.join(ROOT, '.env.does-not-exist-xyz')), false);
  });

  it('loadLocalEnv is safe when files missing or present', () => {
    assert.equal(typeof loadLocalEnv(), 'boolean');
  });
});
