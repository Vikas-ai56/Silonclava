import fs from 'node:fs';
import path from 'node:path';
import { loadTenant, tenantDir } from '../../tenants.mjs';
import { openTenantStore } from '../../tenant-data/store.mjs';
import { tenantDbPath, tenantDbSidecarPaths } from '../../tenant-data/open.mjs';
import { queueDepth, waitingDepth, turnStateCounts, schemaVersion } from '../../tenant-data/queue-store.mjs';
import { scheduledJobs } from '../../tenant-data/cron-store.mjs';
import {
  createTenantBackup,
  verifyTenantBackup,
  restoreTenantBackup,
} from '../../state-backup/backup.mjs';
import { OPENCLAW_VERSION } from '../../config.mjs';
import { isTenantWarm, tenantInFlight } from '../../openclaw/tenant-gateway.mjs';
import { TURN_STATE } from '../../tenant-data/migrations.mjs';

/**
 * Operator-only `tenant state` (SPEC-phase3c §9).
 *
 * Reports metadata only. It never returns decrypted message content or any
 * credential — an operator visibility command must not become a transcript
 * export path, which requires its own compliance and authorization design.
 */

function backupRoot(tenantId) {
  return path.join(tenantDir(tenantId), 'backups');
}

export async function handleResourceAction(request) {
  const tenantId = String(request.target?.tenantId || '');
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  const action = request.action || '';

  if (action === 'status') {
    const dbFile = tenantDbPath(tenantId);
    if (!fs.existsSync(dbFile)) {
      return {
        tenantId,
        mutating: false,
        result: { database: null, warm: isTenantWarm(tenantId), note: 'no tenant database yet' },
      };
    }
    const store = openTenantStore(tenantId, { readonly: true });
    try {
      const counts = turnStateCounts(store);
      const wal = tenantDbSidecarPaths(tenantId).wal;
      const backups = fs.existsSync(backupRoot(tenantId))
        ? fs.readdirSync(backupRoot(tenantId)).sort()
        : [];
      return {
        tenantId,
        mutating: false,
        result: {
          warm: isTenantWarm(tenantId),
          inFlight: tenantInFlight(tenantId),
          queueDepth: queueDepth(store),
          turnsByState: counts,
          ambiguous: counts[TURN_STATE.DELIVERY_UNKNOWN] || 0,
          waiting: waitingDepth(store),
          schemaVersion: schemaVersion(store),
          walBytes: fs.existsSync(wal) ? fs.statSync(wal).size : 0,
          cronJobs: scheduledJobs(store).length,
          lastBackup: backups.at(-1) || null,
        },
      };
    } finally {
      store.db.close();
    }
  }

  if (action === 'backup') {
    // Backup runs on the writer connection: a copy started from a second
    // connection restarts on every write and may never converge (§4).
    const store = openTenantStore(tenantId);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(backupRoot(tenantId), stamp);
      const manifest = await createTenantBackup(store, tenantDir(tenantId), dest, {
        openclawVersion: OPENCLAW_VERSION,
      });
      const verified = verifyTenantBackup(dest);
      if (!verified.ok) throw new Error(`Backup failed verification: ${JSON.stringify(verified)}`);
      return {
        tenantId,
        mutating: true,
        auditResult: { backupId: stamp, verified: true },
        result: { backupId: stamp, files: Object.keys(manifest.files).length, verified: true },
      };
    } finally {
      store.db.close();
    }
  }

  if (action === 'restore') {
    const backupId = String(request.params?.backup || '');
    if (!backupId) throw new Error('state restore requires --backup <backup-id>');
    if (isTenantWarm(tenantId)) {
      throw new Error('Restore requires a stopped tenant; its container is still warm');
    }
    const src = path.join(backupRoot(tenantId), backupId);
    const staging = path.join(tenantDir(tenantId), `restore-${backupId}`);
    const out = restoreTenantBackup(src, staging, tenantId);
    return {
      tenantId,
      mutating: true,
      auditResult: { backupId, staged: true },
      // Staged only. Activation is a separate deliberate step, and the previous
      // directory stays as a rollback point until cold start verifies (§8).
      result: { stagedAt: out.stagingDir, activated: false, manifest: out.manifest.createdAt },
    };
  }

  throw new Error(`Unsupported state action: ${action || '<empty>'}`);
}
