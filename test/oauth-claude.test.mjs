import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createClaudeOAuthSession,
  peekClaudeOAuthSession,
  takeClaudeOAuthSession,
  peekClaudeOAuthSessionForTenant,
} from '../src/tenant-cli/providers/claude/oauth.mjs';
import {
  parseClaudeOAuthPaste,
  looksLikeClaudeOAuthPaste,
} from '../src/tenant-cli/providers/claude/inbound.mjs';
import {
  claudeReady,
  writeTenantClaudeCredentials,
} from '../src/tenant-cli/providers/claude/credentials.mjs';
import { completeClaudeLogin } from '../src/tenant-cli/providers/claude/index.mjs';
import { loadLlmMetadata } from '../src/tenant-cli/providers/llm-metadata.mjs';
import { tenantClaudeConfigDir } from '../src/cli-home.mjs';
import { saveTenant } from '../src/tenants.mjs';
import { rmTenant, tempTenantId, withMockFetch } from './helpers.mjs';

describe('claude oauth', () => {
  const id = tempTenantId('1557');

  after(async () => {
    await rmTenant(id);
  });

  it('creates session with PKCE authorize URL', () => {
    const { oauthState, authorizeUrl, pastePageUrl } = createClaudeOAuthSession({
      tenantId: id,
      replyJid: `${id}@s.whatsapp.net`,
    });
    assert.ok(oauthState.length > 20);
    assert.match(authorizeUrl, /claude\.ai\/oauth\/authorize/);
    assert.match(authorizeUrl, /client_id=/);
    assert.match(authorizeUrl, /code_challenge=/);
    assert.match(pastePageUrl, /\/connect\/claude\//);

    const peek = peekClaudeOAuthSession(oauthState);
    assert.equal(peek.tenantId, id);
    assert.ok(peek.codeVerifier);

    const byTenant = peekClaudeOAuthSessionForTenant(id);
    assert.equal(byTenant.oauthState, oauthState);

    const taken = takeClaudeOAuthSession(oauthState);
    assert.equal(taken.tenantId, id);
    assert.equal(peekClaudeOAuthSession(oauthState), null);
  });

  it('parseClaudeOAuthPaste handles CODE#STATE and URLs', () => {
    assert.deepEqual(parseClaudeOAuthPaste('ABCDEFGHIJKLM#STATE999'), {
      code: 'ABCDEFGHIJKLM',
      state: 'STATE999',
    });
    assert.deepEqual(parseClaudeOAuthPaste('ABCDEFGHIJKLMNOP', { expectedState: 'ST1' }), {
      code: 'ABCDEFGHIJKLMNOP',
      state: 'ST1',
    });
    assert.equal(parseClaudeOAuthPaste('hello world'), null);
  });

  it('looksLikeClaudeOAuthPaste detects paste shapes', () => {
    assert.equal(looksLikeClaudeOAuthPaste('CODE123#STATE456'), true);
    assert.equal(looksLikeClaudeOAuthPaste('A'.repeat(25)), true);
    assert.equal(looksLikeClaudeOAuthPaste('normal chat message'), false);
    assert.equal(looksLikeClaudeOAuthPaste(''), false);
  });

  it('writeTenantClaudeCredentials persists CLI credential and metadata-only vault', async () => {
    const { expiresAt } = await writeTenantClaudeCredentials(id, {
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
      scope: 'user:inference',
    });
    assert.ok(expiresAt > Date.now());

    const credPath = path.join(tenantClaudeConfigDir(id), '.credentials.json');
    const cred = JSON.parse(await fs.readFile(credPath, 'utf8'));
    assert.equal(cred.claudeAiOauth.accessToken, 'access-abc');

    assert.equal(await claudeReady(id), true);
    const vault = await loadLlmMetadata(id);
    assert.equal(vault.claudeCodeOauthToken, undefined);
    assert.equal(vault.claudeCodeRefreshToken, undefined);
    assert.equal(vault.anthropicApiKey, undefined);
    assert.equal(vault.claudeProvider, 'subscription');
    await assert.rejects(fs.access(path.join(tenantClaudeConfigDir(id), 'credentials.json')));
  });

  it('completeClaudeOAuthFromPaste exchanges code via mock fetch', async () => {
    const tenant = { id, phone: id, jid: `${id}@s.whatsapp.net`, plan: 'claude', state: 'AUTH_PENDING' };
    await saveTenant(tenant);
    const { oauthState } = createClaudeOAuthSession({
      tenantId: id,
      replyJid: `${id}@s.whatsapp.net`,
    });

    await withMockFetch(async (url, init) => {
      assert.match(url, /oauth\/token/);
      assert.equal(init.method, 'POST');
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 7200,
          });
        },
      };
    }, async () => {
      const result = await completeClaudeLogin(tenant, `CODE999#${oauthState}`);
      assert.equal(result.connected, true);
      assert.equal(await claudeReady(id), true);
    });
  });
});
