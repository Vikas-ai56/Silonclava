import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-cli-stdin-'));

after(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('tenant CLI stdin adapter', () => {
  it('accepts the Composio project key through stdin without placing it in argv', () => {
    const key = 'stdin-only-test-composio-key';
    const platform = path.join(temporary, 'platform');
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'bin', 'tenant.mjs'), 'mcp', 'configure', '--backend', 'composio'],
      {
        cwd: root,
        input: `${key}\n`,
        encoding: 'utf8',
        env: {
          ...process.env,
          ROCKY_PLATFORM_DIR: platform,
          ROCKY_TENANTS_DIR: path.join(temporary, 'tenants'),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.configured, true);
    assert.doesNotMatch(result.stdout, new RegExp(key));
    assert.doesNotMatch(result.stderr, new RegExp(key));

    const vault = fs.readFileSync(
      path.join(platform, 'vault', 'composio-platform.json'),
      'utf8',
    );
    assert.doesNotMatch(vault, new RegExp(key));
  });
});
