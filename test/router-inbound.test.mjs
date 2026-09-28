import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockChannel } from '../src/channel.mjs';
import { attachRouter } from '../src/router.mjs';
import { resetScheduler, schedulerStats } from '../src/inbound-queue.mjs';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { ALLOWED_PHONES } from '../src/config.mjs';
import { deleteTenant, findTenantByJid } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const phone = `15557${String(process.pid).slice(-6)}`;
const jid = `${phone}@s.whatsapp.net`;
const created = [];

beforeEach(() => resetScheduler());

after(async () => {
  resetScheduler();
  ALLOWED_PHONES.delete(phone);
  for (const id of created) {
    await deleteTenant(id).catch(() => {});
    fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  }
});

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe('router inbound path', () => {
  it('drops a non-allow-listed sender before any tenant or transcript exists', async () => {
    const saved = [...ALLOWED_PHONES];
    ALLOWED_PHONES.clear();
    ALLOWED_PHONES.add('9990001111');
    try {
      const channel = attachRouter(new MockChannel());
      const strangerJid = `1555888${String(process.pid).slice(-6)}@s.whatsapp.net`;
      await channel.onMessage({ from: strangerJid, text: 'hello?' });
      await settle();

      assert.equal(channel.sent.length, 0, 'a stranger must get no reply');
      assert.equal(await findTenantByJid(strangerJid), null);
      assert.deepEqual(schedulerStats().tenants, {}, 'no lane may be opened');
    } finally {
      ALLOWED_PHONES.clear();
      for (const p of saved) ALLOWED_PHONES.add(p);
    }
  });

  it('resolves the tenant, then persists the message on that tenant lane', async () => {
    ALLOWED_PHONES.add(phone);
    const channel = attachRouter(new MockChannel());

    // First contact onboards inline and creates the tenant.
    await channel.onMessage({ from: jid, text: 'hi' });
    const tenant = await findTenantByJid(jid);
    assert.ok(tenant, 'tenant should exist after first contact');
    created.push(tenant.id);

    // A later message is enqueued durably against the resolved tenant id.
    await channel.onMessage({ from: jid, text: 'Ada' });
    await settle();

    const store = openTenantStore(tenant.id);
    try {
      const messages = store.db.prepare('SELECT direction FROM messages').all();
      assert.ok(messages.length >= 1, 'message should be persisted');
      const lanes = Object.keys(schedulerStats().tenants);
      assert.deepEqual(lanes, [tenant.id], `lane must be keyed on tenant id, got ${lanes}`);
    } finally {
      store.db.close();
    }
  });
});

describe('boot recovery', () => {
  it('does not create a database for a tenant that has never persisted', async () => {
    const { recoverAllTenantLanes } = await import('../src/router.mjs');
    const { tenantDbPath } = await import('../src/tenant-data/open.mjs');
    const { listTenants } = await import('../src/tenants.mjs');

    const before = (await listTenants()).filter((t) => fs.existsSync(tenantDbPath(t.id))).length;
    await recoverAllTenantLanes();
    const after = (await listTenants()).filter((t) => fs.existsSync(tenantDbPath(t.id))).length;

    assert.equal(after, before, 'boot recovery must not create tenant databases');
  });
});
