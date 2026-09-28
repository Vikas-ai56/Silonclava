import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  tenantOpenclawStateDir,
  tenantOpenclawConfigPath,
  buildSpawnCliEnv,
  buildTenantLlmEnv,
} from '../src/openclaw/tenant-openclaw.mjs';
import { updateLlmMetadata } from '../src/tenant-cli/providers/llm-metadata.mjs';
import { tenantCliEnv, tenantClaudeConfigDir } from '../src/cli-home.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';

const TEST_CLAUDE_CREDENTIAL = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 60_000,
  },
});

describe('openclaw cli env builders', () => {
  const customerId = tempTenantId('1562');
  const operatorId = tempTenantId('1563');

  after(async () => {
    await rmTenant(customerId);
    await rmTenant(operatorId);
  });

  it('tenantOpenclaw paths are per-tenant', () => {
    assert.match(tenantOpenclawStateDir(customerId), new RegExp(`${customerId}[/\\\\]openclaw`));
    assert.match(tenantOpenclawConfigPath(customerId), /openclaw\.json$/);
    assert.notEqual(tenantOpenclawStateDir(customerId), tenantOpenclawStateDir(operatorId));
  });

  it('tenantCliEnv returns isolated home dirs', () => {
    const env = tenantCliEnv({ id: customerId });
    assert.match(env.CLAUDE_CONFIG_DIR, new RegExp(`${customerId}[/\\\\]cli-home[/\\\\]claude`));
    assert.match(env.CODEX_HOME, new RegExp(`${customerId}[/\\\\]cli-home[/\\\\]codex`));
  });

  it('buildSpawnCliEnv sets CLAUDE_CONFIG_DIR when cli-home logged in', async () => {
    const dir = tenantClaudeConfigDir(customerId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.credentials.json'), TEST_CLAUDE_CREDENTIAL);
    const env = buildSpawnCliEnv({ id: customerId, plan: 'claude' });
    assert.ok(env.CLAUDE_CONFIG_DIR);
    assert.match(env.CLAUDE_CONFIG_DIR, new RegExp(`${customerId}[/\\\\]cli-home`));
  });

  it('buildSpawnCliEnv omits CLAUDE_CONFIG_DIR when not logged in', () => {
    const bareId = tempTenantId('1564');
    const env = buildSpawnCliEnv({ id: bareId, plan: 'claude', phone: bareId });
    assert.deepEqual(env, {});
  });

  it('buildTenantLlmEnv never injects Claude secrets from vault', async () => {
    await updateLlmMetadata(customerId, {
      claudeCodeOauthToken: 'oat-123',
      anthropicApiKey: 'sk-ant-test',
    });
    const env = await buildTenantLlmEnv({ id: customerId, plan: 'claude' });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.CLAUDE_CONFIG_DIR);
  });
});
