import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockChannel } from '../src/channel.mjs';
import { withTyping } from '../src/typing.mjs';
import { attachRouter } from '../src/router.mjs';
import { whenActivated } from '../src/tenant-activation.mjs';
import { runAgentTurn } from '../src/agent.mjs';
import { createClaudeOAuthSession } from '../src/tenant-cli/providers/claude/oauth.mjs';
import { loadTenant, saveTenant } from '../src/tenants.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { rmTenant, withMockFetch, tempTenantId } from './helpers.mjs';

describe('typing + channel', () => {
  it('withTyping skips when channel lacks setTyping', async () => {
    assert.equal(await withTyping(null, 'x', async () => 42), 42);
  });

  it('pulses setTyping on/off around work', async () => {
    const events = [];
    const channel = {
      async setTyping(jid, on) {
        events.push({ jid, on });
      },
    };
    const result = await withTyping(channel, '1@s.whatsapp.net', async () => 'done', {
      pulseMs: 30,
    });
    assert.equal(result, 'done');
    assert.equal(events[0].on, true);
    assert.equal(events.at(-1).on, false);
  });

  it('MockChannel sendText and handleInbound via router wiring', async () => {
    const ch = new MockChannel();
    attachRouter(ch);
    assert.equal(typeof ch.onMessage, 'function');
    // Resolution precedes handling now (SPEC-phase3c §5). This sender is not
    // allow-listed here, so resolution is expected to reject it.
    const { handleInbound, resolveInboundSender } = await import('../src/onboarding.mjs');
    const msg = { from: '15551234567@s.whatsapp.net', text: 'hello' };
    const resolved = await resolveInboundSender(msg);
    if (resolved.ok) {
      const result = await handleInbound(ch, msg, resolved);
      assert.ok(result.state);
    } else {
      assert.equal(resolved.reason, 'not_allowlisted');
    }
    await ch.sendText('15551234567@s.whatsapp.net', 'reply');
    assert.equal(ch.lastSentTo('15551234567@s.whatsapp.net')?.text, 'reply');
  });
});

describe('router + agent', () => {
  it('attachRouter wires onMessage', async () => {
    const ch = new MockChannel();
    attachRouter(ch);
    assert.equal(typeof ch.onMessage, 'function');
  });

  it('runAgentTurn rejects an empty message', async () => {
    assert.match(await runAgentTurn({ id: 'x' }, '   '), /did not catch/);
  });

  it('runAgentTurn connect claude returns OAuth link', async () => {
    const id = tempTenantId('1567');
    const tenant = { id, phone: id, jid: `${id}@s.whatsapp.net`, plan: 'claude', state: 'ACTIVE' };
    await saveTenant(tenant);
    const msg = await runAgentTurn(
      tenant,
      'connect claude',
    );
    assert.match(msg, /claude\.ai\/oauth\/authorize/);
    await rmTenant(id);
  });

  it('runAgentTurn completes Claude OAuth paste when session pending', async () => {
    const id = tempTenantId('1569');
    const tenant = { id, phone: id, jid: `${id}@s.whatsapp.net`, plan: 'claude', state: 'AUTH_PENDING' };
    await saveTenant(tenant);
    const { oauthState } = createClaudeOAuthSession({
      tenantId: id,
      replyJid: `${id}@s.whatsapp.net`,
    });
    await withMockFetch(async (url) => {
      if (url.includes('/oauth/token')) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              access_token: 'claude-access',
              refresh_token: 'claude-refresh',
              expires_in: 3600,
            });
          },
        };
      }
      throw new Error(url);
    }, async () => {
      const msg = await runAgentTurn(
        tenant,
        `PASTECODE#${oauthState}`,
      );
      assert.match(msg, /Claude subscription connected/);
      assert.equal((await loadTenant(id)).state, 'ACTIVE');
    });
    // Activation is fire-and-forget from the turn; settle it before teardown.
    await whenActivated(id);
    await rmTenant(id);
  });
});
