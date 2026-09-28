import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OPENCLAW_VERSION } from '../src/config.mjs';

const packageDir = process.env.ROCKY_OPENCLAW_PACKAGE_DIR || '';

describe('pinned OpenClaw Claude backend capabilities', () => {
  it(
    'registers the required CLI session, MCP bridge, and compaction capabilities',
    { skip: packageDir ? false : 'set ROCKY_OPENCLAW_PACKAGE_DIR to an unpacked pinned OpenClaw package' },
    async () => {
      const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
      assert.equal(packageJson.name, 'openclaw');
      assert.equal(packageJson.version, OPENCLAW_VERSION);

      const dist = path.join(packageDir, 'dist');
      // `.mjs` as well as `.js`: 2026.9.x renamed the bundle, and a pattern that
      // silently matched nothing would have passed this test by finding no
      // candidates at all.
      const candidates = (await fs.readdir(dist)).filter((name) =>
        /^cli-backend-.*\.m?js$/.test(name),
      );
      assert.ok(candidates.length > 0, 'no cli-backend bundle found in dist');
      let source = '';
      for (const name of candidates) {
        const text = await fs.readFile(path.join(dist, name), 'utf8');
        if (text.includes('extensions/anthropic/cli-backend.ts')) {
          source = text;
          break;
        }
      }
      assert.ok(source, 'Anthropic CLI backend bundle not found');
      assert.match(source, /bundleMcp:\s*true/);
      assert.match(source, /bundleMcpMode:\s*"claude-config-file"/);
      assert.match(source, /ownsNativeCompaction:\s*true/);
      assert.match(source, /liveSession:\s*"claude-stdio"/);
      // The literal argv pairing changed between releases; what matters is that
      // the backend still scopes Claude to the OpenClaw MCP namespace.
      assert.match(source, /"--allowedTools"/);
      assert.match(source, /mcp__openclaw__\*/);
    },
  );
});
