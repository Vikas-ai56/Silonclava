import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateTenantId } from '../src/phone.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import {
  deleteTenant,
  findTenantByJid,
  findTenantByPhone,
  indexLockOwnerMatches,
  readTenantIndex,
  saveTenant,
} from '../src/tenants.mjs';

describe('tenant index atomicity', () => {
  it('retains all 20 concurrent saveTenant mutations', async () => {
    const tenants = Array.from({ length: 20 }, (_, index) => {
      const id = generateTenantId();
      const phone = `15558${String(process.pid).slice(-4)}${String(index).padStart(2, '0')}`;
      return { id, phone, jid: `${phone}@s.whatsapp.net`, name: `Concurrent ${index}`, state: 'ACTIVE' };
    });

    try {
      await Promise.all(tenants.map((tenant) => saveTenant(tenant)));
      const index = await readTenantIndex();
      for (const tenant of tenants) {
        assert.equal(index.byPhone[tenant.phone], tenant.id);
        assert.equal((await findTenantByPhone(tenant.phone))?.id, tenant.id);
      }
    } finally {
      await Promise.all(tenants.map((tenant) => deleteTenant(tenant.id)));
    }
  });

  it('removes stale aliases when a tenant phone or JID changes', async () => {
    const id = generateTenantId();
    const oldPhone = `15557${String(process.pid).slice(-4)}01`;
    const newPhone = `15557${String(process.pid).slice(-4)}02`;
    const oldJid = `${oldPhone}@s.whatsapp.net`;
    const newJid = `${newPhone}@s.whatsapp.net`;
    try {
      await saveTenant({ id, phone: oldPhone, jid: oldJid, name: 'Alias Test', state: 'ACTIVE' });
      await saveTenant({ id, phone: newPhone, jid: newJid, name: 'Alias Test', state: 'ACTIVE' });
      assert.equal(await findTenantByPhone(oldPhone), null);
      assert.equal(await findTenantByJid(oldJid), null);
      assert.equal((await findTenantByPhone(newPhone))?.id, id);
      assert.equal((await findTenantByJid(newJid))?.id, id);
    } finally {
      await deleteTenant(id);
    }
  });

  it('does not release a lock whose owner token or inode changed', () => {
    const owner = { token: '100:owner-token' };
    const owned = { dev: 1, ino: 10 };
    assert.equal(indexLockOwnerMatches(owner, owned, '200:replacement', { dev: 1, ino: 10 }), false);
    assert.equal(indexLockOwnerMatches(owner, owned, owner.token, { dev: 1, ino: 11 }), false);
    assert.equal(indexLockOwnerMatches(owner, owned, owner.token, { dev: 1, ino: 10 }), true);
  });

  it('never routes through a legacy phone-named directory without an index grant', async () => {
    const phone = `15556${String(process.pid).slice(-4)}99`;
    const dir = path.join(TENANTS_DIR, phone);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'tenant.json'),
        JSON.stringify({ id: phone, phone, jid: `${phone}@s.whatsapp.net`, state: 'ACTIVE' }),
      );
      assert.equal(await findTenantByPhone(phone), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
