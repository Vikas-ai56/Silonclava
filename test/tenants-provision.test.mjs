import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, loadTenant, findTenantByPhone, findTenantByJid } from '../src/tenants.mjs';
import { signupFromWeb } from '../src/onboarding.mjs';

const phone = `15551${String(process.pid).slice(-6)}`;
const phone2 = `15552${String(process.pid).slice(-6)}`;

const createdIds = [];

after(async () => {
  for (const id of createdIds) await deleteTenant(id);
});

describe('provision + tenants', () => {
  it('creates workspace, openclaw, vault, cli-home isolation dirs', async () => {
    const tenant = await provisionTenant({
      phone,
      jid: `${phone}@s.whatsapp.net`,
      name: 'Test User',
      plan: 'claude',
      email: 't@example.com',
    });
    createdIds.push(tenant.id);
    assert.equal(tenant.state, 'ACTIVE');
    assert.match(tenant.id, /^br_[a-f0-9]{12}$/);
    assert.ok(tenant.workspacePath.includes(tenant.id));
    assert.ok(tenant.openclawStateDir.includes('openclaw'));
    assert.ok(tenant.cliHomePath.includes('cli-home'));

    const loaded = await loadTenant(tenant.id);
    assert.equal(loaded.name, 'Test User');
    assert.equal((await findTenantByPhone(phone)).id, tenant.id);
    assert.equal((await findTenantByJid(`${phone}@s.whatsapp.net`)).id, tenant.id);

    const identity = await fs.readFile(path.join(tenant.workspacePath, 'IDENTITY.md'), 'utf8');
    assert.match(identity, /Test User/);
    const personalUserFile = path.join(tenant.workspacePath, 'USER.md');
    await fs.writeFile(personalUserFile, '# Personal tenant content\n');
    const reprovisioned = await provisionTenant({
      phone,
      jid: `${phone}@s.whatsapp.net`,
      name: 'Test User',
      plan: 'claude',
      email: 't@example.com',
    });
    assert.equal(reprovisioned.id, tenant.id);
    assert.equal(await fs.readFile(personalUserFile, 'utf8'), '# Personal tenant content\n');
    await fs.access(path.join(tenant.cliHomePath, 'claude'));
    await fs.access(path.join(tenant.openclawStateDir, 'openclaw.json'));
  });

  it('signupFromWeb provisions AUTH_PENDING Claude tenant and is idempotent', async () => {
    const first = await signupFromWeb({
      name: 'Web User',
      phone: `+${phone2}`,
      plan: 'claude',
      email: null,
    });
    createdIds.push(first.tenant.id);
    assert.equal(first.created, true);
    assert.equal(first.tenant.plan, 'claude');
    assert.equal(first.tenant.state, 'AUTH_PENDING');

    const second = await signupFromWeb({
      name: 'Web User',
      phone: `+${phone2}`,
      plan: 'claude',
    });
    assert.equal(second.created, false);
  });

  it('concurrent provisioning for one phone resolves to one tenant UID', async () => {
    const racePhone = `15553${String(process.pid).slice(-6)}`;
    const input = {
      phone: racePhone,
      jid: `${racePhone}@s.whatsapp.net`,
      name: 'Race User',
      plan: 'claude',
    };
    const [a, b] = await Promise.all([provisionTenant(input), provisionTenant(input)]);
    createdIds.push(a.id);
    assert.equal(a.id, b.id);
    assert.equal((await findTenantByPhone(racePhone))?.id, a.id);
    const dirs = await fs.readdir(path.dirname(a.workspacePath));
    assert.ok(dirs.includes('workspace'));
  });
});
