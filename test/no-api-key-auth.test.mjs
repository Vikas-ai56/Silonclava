import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildDockerRunArgs } from '../src/openclaw/docker-gateway.mjs';
import { buildTenantLlmEnv } from '../src/openclaw/tenant-openclaw.mjs';
import { stripAnthropicStaticEnv } from '../src/tenant-cli/runtime-credentials.mjs';
import { updateLlmMetadata } from '../src/tenant-cli/providers/llm-metadata.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';

describe('Claude subscription auth boundary', () => {
  it('does not inject Anthropic API/static OAuth env credentials', async () => {
    const tenantId = tempTenantId('1573');
    try {
      await updateLlmMetadata(tenantId, {
        anthropicApiKey: 'sk-ant-forbidden',
        claudeCodeOauthToken: 'forbidden-oauth-token',
        claudeCodeRefreshToken: 'forbidden-refresh-token',
      });
      const env = await buildTenantLlmEnv({ id: tenantId, plan: 'claude' });
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

      const args = buildDockerRunArgs({ tenantId, port: 18790, token: 'gateway-token' });
      const joined = args.join(' ');
      assert.doesNotMatch(joined, /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN/);

      const entrypoint = await fs.readFile('docker/openclaw/entrypoint.sh', 'utf8');
      assert.doesNotMatch(entrypoint, /export (?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=/);
      assert.match(
        entrypoint,
        /unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN/,
      );
      assert.doesNotMatch(entrypoint, /\/tenant\/vault/);

      const inherited = stripAnthropicStaticEnv({
        ...process.env,
        ANTHROPIC_API_KEY: 'host-key',
        ANTHROPIC_AUTH_TOKEN: 'host-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
      });
      assert.equal(inherited.ANTHROPIC_API_KEY, undefined);
      assert.equal(inherited.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(inherited.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    } finally {
      await rmTenant(tenantId);
    }
  });
});
