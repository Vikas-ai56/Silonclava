import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TENANTS_DIR } from '../src/paths.mjs';
import { deprovisionTenant, DEPROVISIONED_DIR } from '../src/tenant-cli/resources/user.mjs';
import { readTenantIndex, writeTenantIndex, saveTenant } from '../src/tenants.mjs';
import { authorizeTenantRequest } from '../src/tenant-cli/authorization.mjs';
import { getResourceDefinition } from '../src/tenant-cli/registry.mjs';

const id = `br_deprov_${process.pid}`;

async function seed() {
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  fs.mkdirSync(path.join(TENANTS_DIR, id, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(TENANTS_DIR, id, 'workspace', 'keep.txt'), 'tenant data');
  await saveTenant({ id, phone: '+15550001111', jid: '15550001111@s.whatsapp.net', plan: 'claude', state: 'ACTIVE' });
  const index = await readTenantIndex();
  index.byJid['15550001111@s.whatsapp.net'] = id;
  index.byPhone['15550001111'] = id;
  await writeTenantIndex(index);
}

describe('deprovision is operator-only', () => {
  const attempt = (kind) => () => authorizeTenantRequest(getResourceDefinition('user'), {
    resource: 'user',
    action: 'deprovision',
    params: {},
    authorization: { kind, tenantId: id },
  });

  it('is unreachable from an agent grant', () => {
    assert.throws(attempt('agent'), /Agent grant does not permit user deprovision/);
  });

  it('is unreachable from a tenant grant', () => {
    assert.throws(attempt('tenant'), /Not authorized for user/);
  });

  it('is allowed for an operator', () => {
    const ok = authorizeTenantRequest(getResourceDefinition('user'), {
      resource: 'user', action: 'deprovision', params: {},
      authorization: { kind: 'operator' }, target: { tenantId: id },
    });
    assert.equal(ok.target.tenantId, id);
  });
});

describe('deprovision', () => {
  it('previews by default and changes nothing', async () => {
    await seed();
    const plan = await deprovisionTenant({ tenantId: id });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.directoryExists, true);
    assert.deepEqual(plan.indexEntries, { byJid: 1, byPhone: 1 });
    assert.ok(fs.existsSync(path.join(TENANTS_DIR, id)), 'dry run must not touch the directory');
    const index = await readTenantIndex();
    assert.equal(index.byPhone['15550001111'], id, 'dry run must not touch the index');
  });

  it('removes the index entries and archives the directory rather than deleting it', async () => {
    await seed();
    const out = await deprovisionTenant({ tenantId: id, dryRun: false });
    assert.equal(out.dryRun, false);

    const index = await readTenantIndex();
    assert.equal(index.byPhone['15550001111'], undefined);
    assert.equal(index.byJid['15550001111@s.whatsapp.net'], undefined);
    assert.ok(!fs.existsSync(path.join(TENANTS_DIR, id)), 'the live directory is gone');

    assert.ok(out.archived && fs.existsSync(out.archived), 'the directory is archived, not destroyed');
    assert.equal(fs.readFileSync(path.join(out.archived, 'workspace', 'keep.txt'), 'utf8'), 'tenant data');
    assert.ok(out.archived.includes(DEPROVISIONED_DIR));
    fs.rmSync(out.archived, { recursive: true, force: true });
  });

  it('refuses when there is nothing to remove', async () => {
    await assert.rejects(() => deprovisionTenant({ tenantId: 'br_absent_xyz' }), /Nothing to deprovision/);
  });

  it('requires a tenant id', async () => {
    await assert.rejects(() => deprovisionTenant({ tenantId: '' }), /requires a tenant id/);
  });
});

describe('deprovision leaves nothing behind', () => {
  it('does not resurrect the directory it archived', async () => {
    const { appendTenantAudit } = await import('../src/tenant-cli/audit.mjs');
    const gone = `br_gone_${process.pid}`;
    fs.rmSync(path.join(TENANTS_DIR, gone), { recursive: true, force: true });
    // Observed live: the audit line recreated the tenant directory 3ms after
    // the archive moved it, leaving a stray dir holding only audit.jsonl.
    await appendTenantAudit({ tenantId: gone, actor: 'operator', resource: 'user', action: 'deprovision' });
    assert.equal(fs.existsSync(path.join(TENANTS_DIR, gone)), false);
  });

  it('still audits a tenant that exists', async () => {
    const { appendTenantAudit } = await import('../src/tenant-cli/audit.mjs');
    const live = `br_live_${process.pid}`;
    fs.mkdirSync(path.join(TENANTS_DIR, live), { recursive: true });
    try {
      await appendTenantAudit({ tenantId: live, actor: 'operator', resource: 'vault', action: 'status' });
      assert.match(fs.readFileSync(path.join(TENANTS_DIR, live, 'audit.jsonl'), 'utf8'), /"action":"status"/);
    } finally {
      fs.rmSync(path.join(TENANTS_DIR, live), { recursive: true, force: true });
    }
  });

  it('records the removal where it survives the tenant', () => {
    const src = fs.readFileSync('src/tenant-cli/resources/user.mjs', 'utf8');
    const branch = src.slice(src.indexOf("if (action === 'deprovision')"));
    assert.match(branch, /auditScope: 'platform'/);
    assert.match(branch, /auditTenantIds: \[\]/);
  });
});
