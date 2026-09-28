import { loadTenant } from '../../tenants.mjs';
import { assertVaultMasterKey } from '../storage/vault-crypto.mjs';
import { listVaultRecords, verifyVaultRecords } from '../storage/vault-store.mjs';
import { migrateVaultDirectory } from '../../privacy/envelope-migration.mjs';
import { migrateStoreEnvelopes } from '../../tenant-data/envelope-migration.mjs';
import { openTenantStore } from '../../tenant-data/store.mjs';
import { tenantDir } from '../../tenants.mjs';
import path from 'node:path';

export async function handleResourceAction(request) {
  assertVaultMasterKey();
  const tenantId = String(request.target?.tenantId || '');
  if (!(await loadTenant(tenantId))) throw new Error(`Tenant not found: ${tenantId}`);
  if (request.action === 'list') {
    const records = await listVaultRecords(tenantId);
    return { tenantId, mutating: false, result: { records } };
  }
  if (request.action === 'status' || request.action === 'verify') {
    const verification = await verifyVaultRecords(tenantId);
    return {
      tenantId,
      mutating: false,
      result: { configured: true, ...verification },
    };
  }
  if (request.action === 'migrate-envelopes') {
    const dryRun = request.params['dry-run'] === true || request.params.dryRun === true;
    const vault = migrateVaultDirectory(path.join(tenantDir(tenantId), 'vault'), tenantId, { dryRun });
    let store = null;
    let transcript;
    try {
      store = openTenantStore(tenantId);
      transcript = migrateStoreEnvelopes(store, { dryRun });
    } finally {
      store?.db?.close?.();
    }
    return {
      tenantId,
      mutating: !dryRun,
      audit: true,
      auditResult: { dryRun, vault: vault.migrated, transcript: transcript.migrated },
      result: { dryRun, vault, transcript },
    };
  }
  if (request.action === 'rotate') {
    throw new Error('Vault key rotation requires the approved keyring runbook and is not enabled');
  }
  throw new Error(`Unsupported vault action: ${request.action || '<empty>'}`);
}

