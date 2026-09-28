import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  claudeReady,
  codexReady,
  legacyCodexEnv,
  claudeCredentialStatus,
  stripAnthropicStaticEnv,
} from '../src/tenant-cli/runtime-credentials.mjs';
import {
  loadLlmMetadata,
  updateLlmMetadata,
} from '../src/tenant-cli/providers/llm-metadata.mjs';
import { tenantDir } from '../src/tenants.mjs';
import { PUBLIC_BASE_URL } from '../src/config.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';

describe('llm-auth', () => {
  const id = tempTenantId('1556');

  after(async () => {
    await rmTenant(id);
  });

  it('save/load vault and readiness flags', async () => {
    assert.equal(await loadLlmMetadata(id), null);
    assert.equal(await claudeReady(id), false);
    assert.equal(await codexReady(id), false);

    await updateLlmMetadata(id, { anthropicApiKey: 'sk-ant-test' });
    assert.equal(await claudeReady(id), false);
    assert.equal((await loadLlmMetadata(id)).anthropicApiKey, undefined);

    await updateLlmMetadata(id, { openaiApiKey: 'sk-openai-test', anthropicApiKey: null });
    assert.equal(await claudeReady(id), false);
    assert.equal(await codexReady(id), true);
    const vaultFile = path.join(tenantDir(id), 'vault', 'llm-auth.json');
    const raw = await fs.readFile(vaultFile, 'utf8');
    assert.doesNotMatch(raw, /sk-openai-test/);
    assert.equal(JSON.parse(raw)._rockyVault, 2);
    assert.equal((await fs.stat(vaultFile)).mode & 0o777, 0o600);
  });

  it('llmAuthEnv exposes legacy Codex only and strips Claude secrets', async () => {
    await updateLlmMetadata(id, {
      claudeCodeOauthToken: 'oat-token',
      openaiApiKey: 'sk-xyz',
    });
    const env = await legacyCodexEnv(id);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, 'sk-xyz');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it('reports access-only Claude credentials as connected but degraded', async () => {
    const dir = path.join(tenantDir(id), 'cli-home', 'claude');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'access-only', expiresAt: Date.now() + 60_000 } }),
    );
    const status = await claudeCredentialStatus(id);
    assert.equal(status.connected, true);
    assert.equal(status.refreshable, false);
    assert.equal(status.degraded, true);
    assert.equal(await claudeReady(id), true);
  });

  it('strips host Anthropic credentials without removing unrelated env', () => {
    const env = stripAnthropicStaticEnv({
      ANTHROPIC_API_KEY: 'forbidden',
      ANTHROPIC_AUTH_TOKEN: 'forbidden',
      CLAUDE_CODE_OAUTH_TOKEN: 'forbidden',
      PATH: '/test/bin',
    });
    assert.deepEqual(env, { PATH: '/test/bin' });
  });

});
