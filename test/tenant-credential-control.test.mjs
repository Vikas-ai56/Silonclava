import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeOAuthCallback,
  createTenantClient,
  executeTenantCommand,
  inspectOAuthCallback,
} from '../src/tenant-cli/index.mjs';
import { peekClaudeOAuthSession } from '../src/tenant-cli/providers/claude/oauth.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, loadTenant } from '../src/tenants.mjs';
import { withMockFetch } from './helpers.mjs';

const operatorContext = {
  authorization: { kind: 'operator', principal: 'credential-control-test' },
};

describe('tenant credential control plane', () => {
  const ids = [];

  after(async () => {
    for (const id of ids) await deleteTenant(id);
  });

  it('binds typed clients and Claude callbacks to the server-resolved tenant', async () => {
    const suffix = String(Date.now()).slice(-8);
    const a = await provisionTenant({
      phone: `1591${suffix}`,
      jid: `1591${suffix}@s.whatsapp.net`,
      name: 'Credential A',
      plan: 'claude',
      finalState: 'AUTH_PENDING',
    });
    const b = await provisionTenant({
      phone: `1592${suffix}`,
      jid: `1592${suffix}@s.whatsapp.net`,
      name: 'Credential B',
      plan: 'claude',
      finalState: 'AUTH_PENDING',
    });
    ids.push(a.id, b.id);

    const client = createTenantClient({ tenantId: a.id, principal: `test:${a.id}` });
    const login = await client.auth('claude').login({ replyJid: a.jid, tenant: b.id });
    const state = new URL(login.result.authorizeUrl).searchParams.get('state');
    assert.equal(peekClaudeOAuthSession(state)?.tenantId, a.id);
    assert.notEqual(peekClaudeOAuthSession(state)?.tenantId, b.id);

    const callback = await inspectOAuthCallback('claude', state);
    assert.equal(callback.tenantId, a.id);
    await withMockFetch(async (url) => {
      assert.match(url, /oauth\/token/);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'callback-access-secret',
          refresh_token: 'callback-refresh-secret',
          expires_in: 3600,
        }),
      };
    }, async () => {
      const completed = await completeOAuthCallback('claude', { state, code: 'CALLBACKCODE' });
      assert.equal(completed.tenantId, a.id);
      assert.equal(completed.result.connected, true);
      assert.doesNotMatch(JSON.stringify(completed), /callback-(?:access|refresh)-secret/);
    });
    assert.equal((await loadTenant(a.id)).state, 'ACTIVE');
    assert.equal((await loadTenant(b.id)).state, 'AUTH_PENDING');
    await assert.rejects(
      completeOAuthCallback('claude', { state, code: 'REPLAY' }),
      /invalid or expired/i,
    );
  });

  it('rejects incomplete callbacks before consuming pending state', async () => {
    const suffix = String(Date.now()).slice(-8);
    const tenant = await provisionTenant({
      phone: `1596${suffix}`,
      jid: `1596${suffix}@s.whatsapp.net`,
      name: 'Callback Validation',
      plan: 'claude',
      finalState: 'AUTH_PENDING',
    });
    ids.push(tenant.id);
    const login = await createTenantClient({
      tenantId: tenant.id,
      principal: `test:${tenant.id}`,
    }).auth('claude').login({ replyJid: tenant.jid });
    const state = new URL(login.result.authorizeUrl).searchParams.get('state');

    await assert.rejects(
      completeOAuthCallback('claude', { state, code: '' }),
      /requires both code and state/i,
    );
    assert.equal((await inspectOAuthCallback('claude', state)).tenantId, tenant.id);
  });

  it('validates route backends through the registry', async () => {
    const suffix = String(Date.now()).slice(-8);
    const tenant = await provisionTenant({
      phone: `1594${suffix}`,
      jid: `1594${suffix}@s.whatsapp.net`,
      name: 'Route Registry',
      plan: 'claude',
    });
    ids.push(tenant.id);
    await assert.rejects(
      executeTenantCommand([
        'route', 'set', '--tenant', tenant.id, '--backend', 'unknown-backend',
      ], operatorContext),
      /unknown route backend/i,
    );
  });
});
