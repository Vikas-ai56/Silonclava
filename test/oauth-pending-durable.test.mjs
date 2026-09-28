import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tenantDir } from '../src/tenants.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';

describe('durable Claude OAuth pending state', () => {
  it('survives a module reload and remains single-use', async () => {
    const tenantId = tempTenantId('1570');
    try {
      const first = await import(`../src/tenant-cli/providers/claude/oauth.mjs?create=${Date.now()}`);
      const created = first.createClaudeOAuthSession({ tenantId, replyJid: `${tenantId}@s.whatsapp.net` });
      const reloaded = await import(`../src/tenant-cli/providers/claude/oauth.mjs?reload=${Date.now()}`);
      assert.equal(reloaded.peekClaudeOAuthSession(created.oauthState)?.tenantId, tenantId);
      assert.equal(reloaded.takeClaudeOAuthSession(created.oauthState)?.tenantId, tenantId);
      assert.equal(first.takeClaudeOAuthSession(created.oauthState), null);
    } finally {
      await rmTenant(tenantId);
    }
  });

  it('expires stale state and does not let another tenant consume it', async () => {
    const owner = tempTenantId('1571');
    const other = tempTenantId('1572');
    const oauth = await import(`../src/tenant-cli/providers/claude/oauth.mjs?expiry=${Date.now()}`);
    const provider = await import(`../src/tenant-cli/providers/claude/index.mjs?expiry=${Date.now()}`);
    try {
      const created = oauth.createClaudeOAuthSession({ tenantId: owner, replyJid: `${owner}@s.whatsapp.net` });
      await assert.rejects(
        provider.completeClaudeLogin(
          { id: other, jid: `${other}@s.whatsapp.net` },
          `CODEVALUE#${created.oauthState}`,
        ),
        /different workspace/i,
      );
      assert.equal(oauth.peekClaudeOAuthSession(created.oauthState)?.tenantId, owner);

      const file = path.join(tenantDir(owner), 'auth', 'pending', `claude-${created.oauthState}.json`);
      const row = JSON.parse(await fs.readFile(file, 'utf8'));
      row.createdAt = Date.now() - 2 * 60 * 60 * 1000;
      await fs.writeFile(file, `${JSON.stringify(row)}\n`);
      assert.equal(oauth.peekClaudeOAuthSession(created.oauthState), null);
      await assert.rejects(fs.access(file));
    } finally {
      await rmTenant(owner);
      await rmTenant(other);
    }
  });
});
