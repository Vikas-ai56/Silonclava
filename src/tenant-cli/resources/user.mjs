import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateTenantId, tenantIdFromPhone } from '../../phone.mjs';
import { TENANTS_DIR } from '../../paths.mjs';
import {
  readTenantIndex,
  withTenantIndexLock,
  writeTenantIndex,
  updateTenantIndex,
  tenantDir,
} from '../../tenants.mjs';
import { dockerContainerName, dockerRemoveContainer } from '../../openclaw/docker-gateway.mjs';
import {
  normalizeLegacyClaudeAuthAtDirectory,
  restoreLegacyClaudeAuthAtDirectory,
} from '../providers/claude/credentials.mjs';
import {
  rebindPendingAuthForTenantDirectory,
  restorePendingAuthRecords,
} from '../storage/pending-auth.mjs';
import {
  rebindTenantVaultRecords,
  restoreVaultRecords,
} from '../storage/vault-store.mjs';

function isStableUid(id) {
  return /^br_[a-f0-9]{12}$/.test(id);
}

function allocateUniqueUid(idFactory, used, targets) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = idFactory();
    if (!isStableUid(candidate)) throw new Error(`UID factory returned invalid id: ${candidate}`);
    if (!used.has(candidate) && !targets.has(candidate)) return candidate;
  }
  throw new Error('Tenant UID collision persisted after 100 allocation attempts');
}

function migrationStamp() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function manifestPathFor(stamp) {
  return path.join(TENANTS_DIR, `migration-manifest-${stamp}.json`);
}

function resolveManifestPath(input) {
  const resolved = path.resolve(String(input || ''));
  const relative = path.relative(TENANTS_DIR, resolved);
  if (
    !input ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== '.' ||
    !path.basename(relative).startsWith('migration-manifest-') ||
    !relative.endsWith('.json')
  ) {
    throw new Error('Migration manifest must be a migration-manifest-*.json file inside the tenant root');
  }
  return resolved;
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function legacySignals(dir) {
  return {
    hasLegacyClaudeCredential: await exists(path.join(dir, 'cli-home', 'claude', 'credentials.json')),
    hasClaudeCredential: await exists(path.join(dir, 'cli-home', 'claude', '.credentials.json')),
    hasLlmVault: await exists(path.join(dir, 'vault', 'llm-auth.json')),
  };
}

function rewriteTenantPaths(tenant, oldDir, newDir, newId) {
  const next = { ...tenant, id: newId, updatedAt: new Date().toISOString() };
  for (const key of [
    'workspacePath',
    'vaultPath',
    'openclawStateDir',
    'openclawConfigPath',
    'cliHomePath',
    'claudeConfigDir',
    'codexHomePath',
  ]) {
    if (typeof next[key] === 'string' && next[key].startsWith(oldDir)) {
      next[key] = `${newDir}${next[key].slice(oldDir.length)}`;
    }
  }
  return next;
}

export async function planTenantIdMigration({
  idFactory = generateTenantId,
  quarantineIncomplete = false,
  dropStaleIndex = false,
  stamp = migrationStamp(),
} = {}) {
  await fs.mkdir(TENANTS_DIR, { recursive: true });
  const entries = await fs.readdir(TENANTS_DIR, { withFileTypes: true });
  const diskIds = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const index = await readTenantIndex();
  const indexedIds = new Set([
    ...Object.values(index.byJid),
    ...Object.values(index.byPhone),
  ]);
  const used = new Set([...diskIds, ...indexedIds]);
  const targets = new Set();
  const actions = [];
  const quarantineRoot = path.join('quarantine', stamp);

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'quarantine' || entry.name.startsWith('.')) continue;
    const source = path.join(TENANTS_DIR, entry.name);
    if (entry.name.startsWith('__test_')) {
      actions.push({
        kind: 'quarantine',
        from: entry.name,
        to: path.join(quarantineRoot, entry.name),
        classification: 'declared-test',
        ...(await legacySignals(source)),
      });
      continue;
    }
    if (isStableUid(entry.name)) continue;

    let raw;
    let tenant;
    try {
      raw = await fs.readFile(path.join(source, 'tenant.json'));
      tenant = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      const details = {
        from: entry.name,
        to: quarantineIncomplete ? path.join(quarantineRoot, entry.name) : null,
        source: 'directory',
        reason: `tenant.json missing or invalid (${err?.message || err})`,
        classification: quarantineIncomplete ? 'operator-declared-legacy-fragment' : 'unclassified',
        ...(await legacySignals(source)),
      };
      actions.push({ kind: quarantineIncomplete ? 'quarantine' : 'blocked', ...details });
      continue;
    }

    const target = isStableUid(tenant.id)
      ? tenant.id
      : allocateUniqueUid(idFactory, used, targets);
    if (used.has(target) || targets.has(target)) {
      throw new Error(`Tenant UID collision: ${entry.name} -> ${target}`);
    }
    targets.add(target);
    actions.push({
      kind: 'rekey',
      from: entry.name,
      to: target,
      sourceTenantSha256: sha256(raw),
    });
  }

  for (const id of [...indexedIds].sort()) {
    if (diskIds.has(id)) continue;
    actions.push({
      kind: dropStaleIndex ? 'drop-index' : 'blocked',
      from: id,
      to: null,
      source: 'index',
      reason: 'index points to a missing tenant directory',
      classification: dropStaleIndex ? 'operator-declared-stale-index' : 'unclassified',
    });
  }
  return actions;
}

async function loadManifest(input) {
  const manifestPath = resolveManifestPath(input);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.actions)) throw new Error(`Invalid migration manifest: ${manifestPath}`);
  return { manifestPath, manifest };
}

async function prepareApplyActions(manifest) {
  const prepared = [];
  for (const action of manifest.actions) {
    if (action.kind === 'blocked') {
      throw new Error('Migration manifest contains blocked entries; create a new explicit dry-run plan first');
    }
    if (!['rekey', 'quarantine', 'drop-index'].includes(action.kind)) {
      throw new Error(`Unsupported migration action in manifest: ${action.kind}`);
    }
    if (action.kind === 'drop-index') {
      prepared.push({ ...action });
      continue;
    }
    const sourceId = String(action.from || '');
    if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) {
      throw new Error(`Invalid migration source in manifest: ${sourceId || '<empty>'}`);
    }
    const from = path.join(TENANTS_DIR, sourceId);
    let to;
    if (action.kind === 'rekey') {
      if (!isStableUid(action.to)) throw new Error(`Invalid rekey target in manifest: ${action.to}`);
      to = path.join(TENANTS_DIR, action.to);
    } else {
      const parts = String(action.to || '').split(/[\\/]/);
      if (
        parts.length !== 3 ||
        parts[0] !== 'quarantine' ||
        parts[1] !== manifest.stamp ||
        parts[2] !== sourceId ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1])
      ) {
        throw new Error(`Invalid quarantine target in manifest: ${action.to || '<empty>'}`);
      }
      to = path.join(TENANTS_DIR, ...parts);
    }
    if (!(await exists(from))) throw new Error(`Migration source no longer exists: ${action.from}`);
    if (await exists(to)) throw new Error(`Migration target already exists: ${action.to}`);
    if (action.kind === 'rekey') {
      const raw = await fs.readFile(path.join(from, 'tenant.json'));
      if (sha256(raw) !== action.sourceTenantSha256) {
        throw new Error(`Tenant changed after dry-run; create a new manifest: ${action.from}`);
      }
      prepared.push({ ...action, tenant: JSON.parse(raw.toString('utf8')), fromPath: from, toPath: to });
    } else {
      prepared.push({ ...action, fromPath: from, toPath: to });
    }
  }
  return prepared;
}

function rewriteIndexForActions(index, actions) {
  for (const action of actions) {
    for (const mapName of ['byJid', 'byPhone']) {
      const map = index[mapName];
      for (const [key, value] of Object.entries(map)) {
        if (value !== action.from) continue;
        if (action.kind === 'rekey') map[key] = action.to;
        else delete map[key];
      }
    }
    if (action.kind === 'rekey') {
      if (action.tenant.jid) index.byJid[String(action.tenant.jid)] = action.to;
      if (action.tenant.phone) {
        index.byPhone[tenantIdFromPhone(action.tenant.phone)] = action.to;
      }
    }
  }
}

export async function migrateTenantIds({
  dryRun = true,
  idFactory = generateTenantId,
  manifestPath: requestedManifestPath = null,
  quarantineIncomplete = false,
  dropStaleIndex = false,
} = {}) {
  if (dryRun) {
    const stamp = migrationStamp();
    const actions = await planTenantIdMigration({
      idFactory,
      quarantineIncomplete,
      dropStaleIndex,
      stamp,
    });
    const blockedCount = actions.filter((action) => action.kind === 'blocked').length;
    const manifestPath = manifestPathFor(stamp);
    const manifest = {
      version: 1,
      stamp,
      createdAt: new Date().toISOString(),
      status: blockedCount === 0 ? 'planned' : 'blocked',
      options: { quarantineIncomplete, dropStaleIndex },
      actions,
    };
    await atomicWriteJson(manifestPath, manifest);
    return {
      dryRun: true,
      ready: blockedCount === 0,
      count: actions.length,
      blockedCount,
      manifestPath,
      actions,
    };
  }

  if (!requestedManifestPath) {
    throw new Error('Applying a tenant UID migration requires --manifest from a reviewed --dry-run');
  }
  const { manifestPath, manifest } = await loadManifest(requestedManifestPath);
  if (manifest.status !== 'planned') {
    throw new Error(`Migration manifest is not applicable (status=${manifest.status || 'missing'})`);
  }
  const actions = await prepareApplyActions(manifest);
  const completed = [];
  let originalIndex = null;
  let indexWritten = false;

  try {
    await withTenantIndexLock(async () => {
      originalIndex = await readTenantIndex();
      manifest.status = 'applying';
      manifest.startedAt = new Date().toISOString();
      await atomicWriteJson(manifestPath, manifest);

      try {
        for (const action of actions) {
          if (action.kind === 'drop-index') continue;
          await fs.mkdir(path.dirname(action.toPath), { recursive: true });
          await fs.rename(action.fromPath, action.toPath);
          const completedAction = {
            ...action,
            authNormalization: null,
            authBackups: null,
            pendingAuthBackups: [],
            vaultBackups: [],
          };
          completed.push(completedAction);

          if (action.kind === 'rekey') {
            const nextTenant = rewriteTenantPaths(action.tenant, action.fromPath, action.toPath, action.to);
            await atomicWriteJson(path.join(action.toPath, 'tenant.json'), nextTenant);
            completedAction.pendingAuthBackups = await rebindPendingAuthForTenantDirectory(
              action.toPath,
              action.from,
              action.to,
            );
            completedAction.vaultBackups = await rebindTenantVaultRecords(
              action.toPath,
              action.from,
              action.to,
              { exclude: ['llm-auth'] },
            );
            const normalized = await normalizeLegacyClaudeAuthAtDirectory(action.toPath, {
              sourceTenantId: action.from,
              targetTenantId: action.to,
            });
            completedAction.authNormalization = normalized.result;
            completedAction.authBackups = normalized.backups;
          }
        }

        const nextIndex = structuredClone(originalIndex);
        rewriteIndexForActions(nextIndex, actions);
        await writeTenantIndex(nextIndex);
        indexWritten = true;

        manifest.status = 'complete';
        manifest.completedAt = new Date().toISOString();
        manifest.authNormalization = Object.fromEntries(
          completed
            .filter((entry) => entry.kind === 'rekey')
            .map((entry) => [entry.to, entry.authNormalization]),
        );
        await atomicWriteJson(manifestPath, manifest);
      } catch (err) {
        if (indexWritten && originalIndex) await writeTenantIndex(originalIndex).catch(() => {});
        for (const action of completed.reverse()) {
          if (action.kind === 'rekey') {
            await restoreLegacyClaudeAuthAtDirectory(action.toPath, action.authBackups).catch(() => {});
            await restoreVaultRecords(action.vaultBackups).catch(() => {});
            await restorePendingAuthRecords(action.pendingAuthBackups).catch(() => {});
            await atomicWriteJson(path.join(action.toPath, 'tenant.json'), action.tenant).catch(() => {});
          }
          await fs.rename(action.toPath, action.fromPath).catch(() => {});
        }
        throw err;
      }
    });
  } catch (err) {
    manifest.status = 'rolled-back';
    manifest.error = String(err?.message || err);
    manifest.rolledBackAt = new Date().toISOString();
    await atomicWriteJson(manifestPath, manifest).catch(() => {});
    throw err;
  }

  return {
    dryRun: false,
    count: actions.length,
    manifestPath,
    actions: manifest.actions,
    authNormalization: manifest.authNormalization,
  };
}

export async function handleResourceAction(request) {
  const { action } = request;
  const options = request.params || {};
  if (action === 'deprovision') {
    if (options.apply != null && options.apply !== true) {
      throw new Error('--apply does not take a value; use bare --apply after reviewing the plan');
    }
    const target = String(options.tenant || request.target?.tenantId || '').trim();
    const result = await deprovisionTenant({ tenantId: target, dryRun: options.apply !== true });
    return {
      tenantId: target,
      auditTenantIds: [],
      auditScope: 'platform',
      mutating: !result.dryRun,
      result,
    };
  }
  if (action !== 'migrate-ids') throw new Error(`Unsupported user action: ${action || '<empty>'}`);
  if (options.apply != null && options.apply !== true) {
    throw new Error('--apply does not take a value; use bare --apply after reviewing a manifest');
  }
  if (options['dry-run'] != null && options['dry-run'] !== true) {
    throw new Error('--dry-run does not take a value; use bare --dry-run');
  }
  if (options.apply === true && options['dry-run'] === true) {
    throw new Error('Choose either --dry-run or --apply, not both');
  }
  const dryRun = options.apply !== true;
  const result = await migrateTenantIds({
    dryRun,
    manifestPath: options.manifest || null,
    quarantineIncomplete: options['quarantine-incomplete'] === true,
    dropStaleIndex: options['drop-stale-index'] === true,
  });
  return {
    tenantId: null,
    auditTenantIds: result.dryRun
      ? []
      : result.actions.filter((entry) => entry.kind === 'rekey').map((entry) => entry.to),
    mutating: !result.dryRun,
    result,
  };
}

export const DEPROVISIONED_DIR = '.deprovisioned';

/**
 * Remove a tenant: index entries first, then the container, then the
 * directory. That order matters — an index entry pointing at a directory that
 * is already gone resolves to a tenant whose files are missing, which errors
 * on every message instead of letting the sender onboard again.
 *
 * The directory is moved aside, not deleted. Recovering an operator mistake in
 * a regulated system must not depend on a backup taken beforehand.
 */
export async function deprovisionTenant({ tenantId, dryRun = true }) {
  const id = String(tenantId || '').trim();
  if (!id) throw new Error('deprovision requires a tenant id');

  const dir = tenantDir(id);
  const index = await readTenantIndex();
  const jidKeys = Object.entries(index.byJid || {}).filter(([, v]) => v === id).map(([k]) => k);
  const phoneKeys = Object.entries(index.byPhone || {}).filter(([, v]) => v === id).map(([k]) => k);
  const container = dockerContainerName(id);
  const directoryExists = await fs
    .stat(dir)
    .then(() => true)
    .catch(() => false);
  const plan = {
    tenantId: id,
    directoryExists,
    indexEntries: { byJid: jidKeys.length, byPhone: phoneKeys.length },
    container,
  };

  if (!plan.directoryExists && !jidKeys.length && !phoneKeys.length) {
    throw new Error(`Nothing to deprovision: ${id} has no directory and no index entries`);
  }
  if (dryRun) return { dryRun: true, ...plan };

  // 1. stop resolving new traffic to this tenant
  await updateTenantIndex((current) => {
    for (const k of jidKeys) delete current.byJid[k];
    for (const k of phoneKeys) delete current.byPhone[k];
    return current;
  });

  // 2. its container holds nothing durable, but it holds a port
  let containerRemoved = false;
  try {
    await dockerRemoveContainer(container);
    containerRemoved = true;
  } catch {
    // already gone, or docker unavailable; the mounts are what mattered
  }

  // 3. move the directory aside
  let archived = null;
  if (plan.directoryExists) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const home = path.join(TENANTS_DIR, DEPROVISIONED_DIR);
    await fs.mkdir(home, { recursive: true });
    archived = path.join(home, `${id}-${stamp}`);
    await fs.rename(dir, archived);
  }

  return { dryRun: false, ...plan, containerRemoved, archived };
}
