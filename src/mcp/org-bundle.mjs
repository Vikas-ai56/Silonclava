import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ORG_DIR } from '../paths.mjs';

function insideOrg(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid organization manifest path: ${relativePath || '<empty>'}`);
  }
  const target = path.resolve(ORG_DIR, normalized);
  const root = `${path.resolve(ORG_DIR)}${path.sep}`;
  if (!target.startsWith(root)) throw new Error(`Organization path escapes bundle: ${relativePath}`);
  return target;
}

export async function readOrgMcpRegistry() {
  const raw = JSON.parse(await fs.readFile(path.join(ORG_DIR, 'mcp', 'registry.json'), 'utf8'));
  if (
    raw.schemaVersion !== 2 ||
    raw.provider !== 'composio' ||
    !raw.toolkits ||
    typeof raw.toolkits !== 'object'
  ) {
    throw new Error('Unsupported organization MCP registry schema');
  }
  for (const [slug, entry] of Object.entries(raw.toolkits)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug) || !entry || typeof entry !== 'object') {
      throw new Error(`Invalid organization toolkit: ${slug}`);
    }
    if ('url' in entry || 'headers' in entry) {
      throw new Error(`Organization toolkit ${slug} contains forbidden MCP runtime configuration`);
    }
    // An enabled toolkit must state its reachable surface explicitly. Either a
    // read-only `toolFilter.include`, or `access: "full"` as a deliberate
    // opt-in to read/write/delete.
    //
    // Still fail-closed: omitting both is an error, so full access can never be
    // acquired by forgetting a filter. `access: "full"` invalidates the total
    // re-execution guarantee (SPEC-phase3c §6) — see `writesEnabled()` below
    // and the "Write-tool gate" row in DECISIONS.md.
    if (entry.enabled) {
      const include = entry.toolFilter && entry.toolFilter.include;
      const fullAccess = entry.access === 'full';
      if (fullAccess && include) {
        throw new Error(
          `Organization toolkit ${slug} sets both access: "full" and a toolFilter; pick one`,
        );
      }
      if (!fullAccess) {
        if (!Array.isArray(include) || include.length === 0) {
          throw new Error(
            `Organization toolkit ${slug} is enabled without a read-only toolFilter.include ` +
              'or an explicit access: "full"',
          );
        }
        if (include.some((t) => typeof t !== 'string' || !t.trim())) {
          throw new Error(`Organization toolkit ${slug} has an invalid toolFilter.include entry`);
        }
      }
    }
  }
  return raw;
}

export async function verifyOrgBundle() {
  const manifestPath = path.join(ORG_DIR, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.version || !manifest.files) {
    throw new Error('Invalid organization bundle manifest');
  }
  const errors = [];
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    try {
      const contents = await fs.readFile(insideOrg(relativePath));
      const actual = crypto.createHash('sha256').update(contents).digest('hex');
      if (actual !== expected) errors.push(`${relativePath}: checksum mismatch`);
    } catch (err) {
      errors.push(`${relativePath}: ${err?.code === 'ENOENT' ? 'missing' : err?.message || err}`);
    }
  }
  return {
    ok: errors.length === 0,
    version: manifest.version,
    checked: Object.keys(manifest.files).length,
    errors,
  };
}

async function bundleFiles(directory = ORG_DIR, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === 'manifest.json' || entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) result.push(...await bundleFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

export async function buildOrgBundle(version) {
  const normalized = String(version || '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(normalized)) {
    throw new Error('Organization bundle version must be 1-80 safe characters');
  }
  await readOrgMcpRegistry();
  const files = {};
  for (const relative of await bundleFiles()) {
    const contents = await fs.readFile(insideOrg(relative));
    files[relative] = crypto.createHash('sha256').update(contents).digest('hex');
  }
  const manifest = {
    schemaVersion: 1,
    version: normalized,
    approval: { scope: 'organization', status: 'approved' },
    files,
  };
  const manifestPath = path.join(ORG_DIR, 'manifest.json');
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, manifestPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { version: normalized, files: Object.keys(files).length };
}

export function approvedToolkitsForTenant(registry, tenant) {
  return Object.entries(registry.toolkits)
    .filter(([, entry]) => entry.enabled === true)
    .filter(([, entry]) => !entry.eligiblePlans?.length || entry.eligiblePlans.includes(tenant.plan))
    .map(([slug, entry]) => ({ slug, ...entry }));
}

/**
 * Whether any enabled toolkit can perform writes.
 *
 * This is the switch behind SPEC-phase3c §6's validity condition: total
 * re-execution is safe **only** while every reachable action is read-only.
 * With `access: "full"`, re-running an interrupted turn could repeat a send, a
 * create, or a delete — so recovery must stop being automatic.
 */
export function writesEnabled(registry) {
  return Object.values(registry?.toolkits || {}).some(
    (t) => t && t.enabled && t.access === 'full',
  );
}
