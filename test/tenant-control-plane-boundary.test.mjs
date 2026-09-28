import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function sourceFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.name.endsWith('.mjs')) files.push(target);
  }
  return files;
}

describe('tenant credential control-plane boundary', () => {
  it('has no legacy OAuth, vault, or LLM-auth production entrypoints', async () => {
    for (const target of [
      'src/oauth/claude.mjs',
      'src/oauth/google.mjs',
      'src/oauth/pending-store.mjs',
      'src/vault/store.mjs',
      'src/vault/crypto.mjs',
      'src/llm-auth.mjs',
    ]) {
      await assert.rejects(fs.access(target), { code: 'ENOENT' });
    }
  });

  it('prevents production callers from importing private credential modules', async () => {
    const violations = [];
    for (const file of await sourceFiles('src')) {
      if (file.startsWith(path.join('src', 'tenant-cli') + path.sep)) continue;
      const raw = await fs.readFile(file, 'utf8');
      if (/tenant-cli\/(?:providers|storage|resources|command|authorization|registry)\//.test(raw)) {
        violations.push(file);
      }
      if (/(?:oauth|vault)\/(?:claude|google|pending-store|store|crypto)\.mjs|llm-auth\.mjs/.test(raw)) {
        violations.push(file);
      }
    }
    assert.deepEqual([...new Set(violations)], []);
  });

  it('keeps channel, callback, and CLI-home on public facades', async () => {
    const agent = await fs.readFile('src/agent.mjs', 'utf8');
    const gateway = await fs.readFile('src/index.mjs', 'utf8');
    const cliHome = await fs.readFile('src/cli-home.mjs', 'utf8');

    assert.doesNotMatch(agent, /runTenantAction|peekPending|OAuthSession|googleConnected/);
    assert.doesNotMatch(gateway, /runTenantAction|peekPending|peekClaudeOAuthSession/);
    assert.doesNotMatch(cliHome, /OAuth|credential|LoggedIn|loginHelp/);
    assert.match(agent, /createTenantClient/);
    assert.match(gateway, /completeOAuthCallback/);
    await assert.rejects(fs.access('src/google/tools.mjs'), { code: 'ENOENT' });
  });
});
