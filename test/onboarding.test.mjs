import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MockChannel } from '../src/channel.mjs';
import {
  handleInbound,
  resolveInboundSender,
  resolveSender,
  signupFromWeb,
} from '../src/onboarding.mjs';

/** Resolution now happens before enqueue (SPEC-phase3c §5), so the test drives
 *  the same two steps the router does. */
async function deliver(channel, msg) {
  const resolved = await resolveInboundSender(msg);
  if (!resolved.ok) return { tenant: null, state: 'IGNORED', resolved };
  return handleInbound(channel, msg, resolved);
}
import { ALLOWED_PHONES } from '../src/config.mjs';
import { deleteTenant, findTenantByJid } from '../src/tenants.mjs';

const phone = `15553${String(process.pid).slice(-6)}`;
const jid = `${phone}@s.whatsapp.net`;
let tenantId;

after(async () => {
  ALLOWED_PHONES.delete(phone);
  if (tenantId) await deleteTenant(tenantId);
});

describe('onboarding', () => {
  it('resolveSender prefers phone JID over LID', () => {
    assert.equal(
      resolveSender({
        from: '123@lid',
        phoneJid: '15551234567@s.whatsapp.net',
      }),
      '15551234567@s.whatsapp.net',
    );
  });

  it('walks NEW → name → plan → AUTH_PENDING provision', async () => {
    // When a host allowlist is configured, temporarily admit this ephemeral test phone.
    ALLOWED_PHONES.add(phone);
    const channel = new MockChannel();

    const a = await deliver(channel, { from: jid, text: 'hi' });
    assert.equal(a.state, 'NEW');
    assert.match(channel.sent.at(-1).text, /Welcome to Rocky/);

    const b = await deliver(channel, { from: jid, text: 'Ada' });
    assert.equal(b.state, 'COLLECT_PLAN');
    assert.match(channel.sent.at(-1).text, /reply claude/i);

    const c = await deliver(channel, { from: jid, text: 'claude' });
    tenantId = c.tenant.id;
    assert.equal(c.state, 'AUTH_PENDING');
    assert.equal(c.tenant.name, 'Ada');
    assert.equal(c.tenant.plan, 'claude');
    assert.match(channel.sent.at(-1).text, /Claude login is required/i);
    await fs.access(path.join(c.tenant.workspacePath, 'IDENTITY.md'));
  });

  it('signupFromWeb rejects bad plan/name', async () => {
    await assert.rejects(() => signupFromWeb({ name: 'X', phone: '+15550001111', plan: 'nope' }), /Choose claude/);
    await assert.rejects(() => signupFromWeb({ name: 'A', phone: '+15550001112', plan: 'claude' }), /name/);
  });

  it('ignores strangers when allowlist excludes sender', async () => {
    const saved = [...ALLOWED_PHONES];
    ALLOWED_PHONES.clear();
    ALLOWED_PHONES.add('9990001111');
    try {
      const channel = new MockChannel();
      // A sender this suite has never provisioned, so "no tenant exists" is
      // actually attributable to the allow-list check.
      const strangerJid = `1555999${String(process.pid).slice(-6)}@s.whatsapp.net`;
      const r = await deliver(channel, { from: strangerJid, text: 'hi' });
      assert.equal(r.state, 'IGNORED');
      assert.equal(r.tenant, null);
      assert.equal(r.resolved.reason, 'not_allowlisted');
      assert.equal(channel.sent.length, 0);
      // The stranger is dropped before any tenant data is created (§5).
      assert.equal(await findTenantByJid(strangerJid), null);
    } finally {
      ALLOWED_PHONES.clear();
      for (const p of saved) ALLOWED_PHONES.add(p);
    }
  });
});
