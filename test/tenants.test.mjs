import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tenantDir, saveTenant, listTenants, loadTenant, deleteTenant } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';

describe('tenants index', () => {
  const id = tempTenantId('1559');
  const jidOnlyId = tempTenantId('1560');
  const jid = `${id}@s.whatsapp.net`;

  after(async () => {
    await deleteTenant(id).catch(() => rmTenant(id));
    await deleteTenant(jidOnlyId).catch(() => rmTenant(jidOnlyId));
  });

  it('lists a JID-only tenant with no phone mapping', async () => {
    await saveTenant({
      id: jidOnlyId,
      phone: null,
      jid: `${jidOnlyId}@s.whatsapp.net`,
      name: 'JID only',
      plan: 'claude',
      state: 'ACTIVE',
    });
    const all = await listTenants();
    assert.ok(all.some((tenant) => tenant.id === jidOnlyId));
  });

  it('tenantDir resolves under tenants/', () => {
    assert.equal(tenantDir(id), path.join(TENANTS_DIR, id));
  });

  it('saveTenant writes tenant.json and index lookups', async () => {
    const tenant = {
      id,
      phone: id,
      jid,
      name: 'Index Test',
      plan: 'claude',
      state: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };
    await saveTenant(tenant);
    const loaded = await loadTenant(id);
    assert.equal(loaded.name, 'Index Test');

    const all = await listTenants();
    assert.ok(all.some((t) => t.id === id));
  });

  it('deleteTenant removes folder and index entries', async () => {
    await saveTenant({
      id,
      phone: id,
      jid,
      name: 'Delete me',
      plan: 'claude',
      state: 'ACTIVE',
    });
    await deleteTenant(id);
    assert.equal(await loadTenant(id), null);
    const all = await listTenants();
    assert.equal(all.some((t) => t.id === id), false);
  });
});
