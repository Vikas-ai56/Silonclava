import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateTenantId } from '../src/phone.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { executeTenantCommand } from '../src/tenant-cli/index.mjs';
import { migrateTenantIds, planTenantIdMigration } from '../src/tenant-cli/resources/user.mjs';
import { findTenantByPhone, readTenantIndex } from '../src/tenants.mjs';
import { loadLlmMetadata } from '../src/tenant-cli/providers/llm-metadata.mjs';
import {
  consumePendingAuth,
  createPendingAuth,
  peekPendingAuth,
} from '../src/tenant-cli/storage/pending-auth.mjs';
import { readVaultRecord, writeVaultRecord } from '../src/tenant-cli/storage/vault-store.mjs';

const cleanup = new Set();
const operatorContext = {
  authorization: { kind: 'operator', principal: 'migration-test' },
};

async function writeLegacy(id) {
  const dir = path.join(TENANTS_DIR, id);
  cleanup.add(dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'tenant.json'),
    `${JSON.stringify({ id, phone: id, jid: `${id}@s.whatsapp.net`, workspacePath: path.join(dir, 'workspace') })}\n`,
  );
}

afterEach(async () => {
  for (const target of cleanup) await fs.rm(target, { recursive: true, force: true });
  cleanup.clear();
  const names = await fs.readdir(TENANTS_DIR).catch(() => []);
  for (const name of names) {
    if (name.startsWith('migration-manifest-')) await fs.rm(path.join(TENANTS_DIR, name), { force: true });
  }
  await fs.rm(path.join(TENANTS_DIR, 'index.json'), { force: true });
  await fs.rm(path.join(TENANTS_DIR, 'quarantine'), { recursive: true, force: true });
});

describe('stable tenant UIDs', () => {
  it('generates opaque phone-independent ids', () => {
    const a = generateTenantId();
    const b = generateTenantId();
    assert.match(a, /^br_[a-f0-9]{12}$/);
    assert.match(b, /^br_[a-f0-9]{12}$/);
    assert.notEqual(a, b);
    assert.doesNotMatch(a, /919632754524/);
  });

  it('dry-runs then rekeys a legacy phone directory with a manifest', async () => {
    const legacy = '15550009991';
    const target = 'br_aaaaaaaaaaaa';
    await writeLegacy(legacy);

    const dry = await migrateTenantIds({ dryRun: true, idFactory: () => target });
    const planned = dry.actions.find((action) => action.from === legacy);
    assert.equal(planned.kind, 'rekey');
    assert.equal(planned.from, legacy);
    assert.equal(planned.to, target);
    assert.match(planned.sourceTenantSha256, /^[a-f0-9]{64}$/);
    await fs.access(path.join(TENANTS_DIR, legacy));

    const applied = await migrateTenantIds({
      dryRun: false,
      manifestPath: dry.manifestPath,
      idFactory: () => 'br_bbbbbbbbbbbb',
    });
    cleanup.add(path.join(TENANTS_DIR, target));
    assert.equal(applied.count, 1);
    const tenant = JSON.parse(await fs.readFile(path.join(TENANTS_DIR, target, 'tenant.json'), 'utf8'));
    assert.equal(tenant.id, target);
    assert.match(tenant.workspacePath, new RegExp(target));
    assert.equal((await findTenantByPhone(legacy))?.id, target);
    await assert.rejects(fs.access(path.join(TENANTS_DIR, legacy)));
    await fs.access(applied.manifestPath);
  });

  it('audits an applied rekey inside the migrated tenant', async () => {
    const legacy = '15550009994';
    await writeLegacy(legacy);

    const dry = await executeTenantCommand([
      'user', 'migrate-ids', '--dry-run', '--json',
    ], operatorContext);
    const applied = await executeTenantCommand([
      'user', 'migrate-ids', '--apply', '--manifest', dry.result.manifestPath,
      '--json',
    ], operatorContext);
    const action = applied.result.actions.find((entry) => entry.from === legacy);
    assert.ok(action?.to);
    cleanup.add(path.join(TENANTS_DIR, action.to));

    const audit = await fs.readFile(path.join(TENANTS_DIR, action.to, 'audit.jsonl'), 'utf8');
    assert.match(audit, /"resource":"user"/);
    assert.match(audit, /"action":"migrate-ids"/);
    assert.match(audit, /"actor":"migration-test"/);
  });

  it('fails the plan on a generated UID collision', async () => {
    await writeLegacy('15550009992');
    await writeLegacy('15550009993');
    await assert.rejects(
      planTenantIdMigration({ idFactory: () => 'br_bbbbbbbbbbbb' }),
      /collision/i,
    );
  });

  it('retries a generated UID collision before failing the migration plan', async () => {
    await writeLegacy('15550009987');
    const occupied = 'br_eeeeeeeeeeee';
    const available = 'br_ffffffffffff';
    const occupiedDir = path.join(TENANTS_DIR, occupied);
    cleanup.add(occupiedDir);
    await fs.mkdir(occupiedDir, { recursive: true });
    let calls = 0;
    const actions = await planTenantIdMigration({
      idFactory: () => (++calls === 1 ? occupied : available),
    });
    assert.equal(actions.find((entry) => entry.from === '15550009987')?.to, available);
    assert.equal(calls, 2);
  });

  it('rejects ambiguous valued migration flags', async () => {
    await assert.rejects(
      executeTenantCommand(['user', 'migrate-ids', '--dry-run=false'], operatorContext),
      /--dry-run does not take a value/i,
    );
    await assert.rejects(
      executeTenantCommand(['user', 'migrate-ids', '--apply=false'], operatorContext),
      /--apply does not take a value/i,
    );
  });

  it('reports incomplete directories and stale index mappings without moving them', async () => {
    const incomplete = '15550009995';
    const incompleteDir = path.join(TENANTS_DIR, incomplete);
    cleanup.add(incompleteDir);
    await fs.mkdir(path.join(incompleteDir, 'vault'), { recursive: true });
    await fs.writeFile(
      path.join(TENANTS_DIR, 'index.json'),
      `${JSON.stringify({ byJid: {}, byPhone: { 15550009996: '15550009996' } }, null, 2)}\n`,
    );

    const dry = await migrateTenantIds({ dryRun: true });
    assert.equal(dry.ready, false);
    assert.equal(dry.blockedCount, 2);
    assert.ok(dry.actions.some((entry) => entry.from === incomplete && entry.source === 'directory'));
    assert.ok(dry.actions.some((entry) => entry.from === '15550009996' && entry.source === 'index'));
    await assert.rejects(
      migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath }),
      /not applicable|blocked entries/i,
    );
    await fs.access(incompleteDir);
  });

  it('requires explicit quarantine and stale-index disposition before apply', async () => {
    const incomplete = '15550009997';
    const stale = '15550009998';
    const incompleteDir = path.join(TENANTS_DIR, incomplete);
    cleanup.add(incompleteDir);
    await fs.mkdir(path.join(incompleteDir, 'vault'), { recursive: true });
    await fs.writeFile(
      path.join(TENANTS_DIR, 'index.json'),
      `${JSON.stringify({ byJid: {}, byPhone: { [stale]: stale } }, null, 2)}\n`,
    );

    const dry = await migrateTenantIds({
      dryRun: true,
      quarantineIncomplete: true,
      dropStaleIndex: true,
    });
    assert.equal(dry.ready, true);
    assert.equal(dry.actions.find((entry) => entry.from === incomplete)?.kind, 'quarantine');
    assert.equal(dry.actions.find((entry) => entry.from === stale)?.kind, 'drop-index');

    await migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath });
    await assert.rejects(fs.access(incompleteDir));
    const index = await readTenantIndex();
    assert.equal(index.byPhone[stale], undefined);
  });

  it('normalizes legacy Claude credential copies without exposing token values', async () => {
    const legacy = '15550009989';
    const target = 'br_cccccccccccc';
    const dir = path.join(TENANTS_DIR, legacy);
    await writeLegacy(legacy);
    const legacyCredential = {
      claudeAiOauth: {
        accessToken: 'migration-test-access-secret',
        refreshToken: 'migration-test-refresh-secret',
        expiresAt: Date.now() + 60_000,
      },
    };
    await fs.mkdir(path.join(dir, 'cli-home', 'claude'), { recursive: true });
    await fs.mkdir(path.join(dir, 'vault'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'cli-home', 'claude', 'credentials.json'),
      JSON.stringify(legacyCredential),
    );
    await fs.writeFile(
      path.join(dir, 'vault', 'llm-auth.json'),
      JSON.stringify({
        claudeCodeOauthToken: 'migration-test-access-secret',
        claudeCodeRefreshToken: 'migration-test-refresh-secret',
        accountEmail: 'person@example.com',
      }),
    );

    const dry = await migrateTenantIds({ dryRun: true, idFactory: () => target });
    const applied = await migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath });
    cleanup.add(path.join(TENANTS_DIR, target));

    const canonical = JSON.parse(await fs.readFile(
      path.join(TENANTS_DIR, target, 'cli-home', 'claude', '.credentials.json'),
      'utf8',
    ));
    assert.equal(canonical.claudeAiOauth.refreshToken, 'migration-test-refresh-secret');
    await assert.rejects(fs.access(
      path.join(TENANTS_DIR, target, 'cli-home', 'claude', 'credentials.json'),
    ));
    const vaultRaw = await fs.readFile(
      path.join(TENANTS_DIR, target, 'vault', 'llm-auth.json'),
      'utf8',
    );
    assert.equal(JSON.parse(vaultRaw)._rockyVault, 2);
    assert.doesNotMatch(vaultRaw, /migration-test-(?:access|refresh)-secret|person@example\.com/);
    const vault = await loadLlmMetadata(target);
    assert.equal(vault.claudeCodeOauthToken, undefined);
    assert.equal(vault.claudeCodeRefreshToken, undefined);
    assert.equal(vault.accountEmail, 'person@example.com');
    assert.doesNotMatch(JSON.stringify(applied), /migration-test-(?:access|refresh)-secret/);
  });

  it('rejects apply when tenant data changed after the reviewed dry-run', async () => {
    const legacy = '15550009988';
    await writeLegacy(legacy);
    const dry = await migrateTenantIds({
      dryRun: true,
      idFactory: () => 'br_dddddddddddd',
    });
    await fs.writeFile(
      path.join(TENANTS_DIR, legacy, 'tenant.json'),
      `${JSON.stringify({ id: legacy, phone: legacy, jid: `${legacy}@s.whatsapp.net`, changed: true })}\n`,
    );
    await assert.rejects(
      migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath }),
      /changed after dry-run/i,
    );
    await fs.access(path.join(TENANTS_DIR, legacy));
  });

  it('rebinds durable OAuth state when a legacy tenant id is rekeyed', async () => {
    const legacy = '15550009986';
    const target = 'br_abababababab';
    const state = 'migrationPendingState123';
    await writeLegacy(legacy);
    createPendingAuth({
      provider: 'google',
      tenantId: legacy,
      state,
      payload: { replyJid: `${legacy}@s.whatsapp.net` },
    });

    const dry = await migrateTenantIds({ dryRun: true, idFactory: () => target });
    await migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath });
    cleanup.add(path.join(TENANTS_DIR, target));

    const pending = peekPendingAuth('google', state, { tenantId: target });
    assert.equal(pending?.tenantId, target);
    assert.equal(peekPendingAuth('google', state, { tenantId: legacy }), null);
    assert.equal(consumePendingAuth('google', state, { tenantId: target })?.tenantId, target);
  });

  it('re-encrypts provider vault records for the new tenant identity', async () => {
    const legacy = '15550009985';
    const target = 'br_cdcdcdcdcdcd';
    await writeLegacy(legacy);
    await writeVaultRecord(legacy, 'google-oauth', {
      refresh_token: 'migration-google-refresh-secret',
      services: ['gmail', 'calendar'],
    });

    const dry = await migrateTenantIds({ dryRun: true, idFactory: () => target });
    await migrateTenantIds({ dryRun: false, manifestPath: dry.manifestPath });
    cleanup.add(path.join(TENANTS_DIR, target));

    const migrated = await readVaultRecord(target, 'google-oauth');
    assert.equal(migrated.refresh_token, 'migration-google-refresh-secret');
    const raw = await fs.readFile(
      path.join(TENANTS_DIR, target, 'vault', 'google-oauth.json'),
      'utf8',
    );
    assert.equal(JSON.parse(raw)._rockyVault, 2);
    assert.doesNotMatch(raw, /migration-google-refresh-secret/);
  });
});
