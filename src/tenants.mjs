import fs from 'node:fs/promises';
import path from 'node:path';
import { TENANTS_DIR } from './paths.mjs';
import { generateTenantId, tenantIdFromPhone } from './phone.mjs';
import { fileLockOwnerMatches, withFileLock } from './file-lock.mjs';

const INDEX_FILE = path.join(TENANTS_DIR, 'index.json');
const INDEX_LOCK_FILE = path.join(TENANTS_DIR, '.index.lock');
const LOCK_WAIT_MS = Number(process.env.ROCKY_TENANT_INDEX_LOCK_WAIT_MS || 5_000);

async function ensureDirs() {
  await fs.mkdir(TENANTS_DIR, { recursive: true });
}

function emptyIndex() {
  return { byJid: {}, byPhone: {} };
}

export async function readTenantIndex() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      byJid: parsed?.byJid && typeof parsed.byJid === 'object' ? parsed.byJid : {},
      byPhone: parsed?.byPhone && typeof parsed.byPhone === 'object' ? parsed.byPhone : {},
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyIndex();
    throw new Error(`Cannot read tenant index ${INDEX_FILE}: ${err?.message || err}`);
  }
}

export function indexLockOwnerMatches(owner, ownedStat, currentToken, currentStat) {
  return fileLockOwnerMatches(owner, ownedStat, currentToken, currentStat);
}

export async function withTenantIndexLock(operation) {
  await ensureDirs();
  return withFileLock(INDEX_LOCK_FILE, operation, { waitMs: LOCK_WAIT_MS });
}

export async function writeTenantIndex(index) {
  await ensureDirs();
  const temp = `${INDEX_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, INDEX_FILE);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

export async function updateTenantIndex(mutator) {
  return withTenantIndexLock(async () => {
    const index = await readTenantIndex();
    const result = await mutator(index);
    await writeTenantIndex(index);
    return result;
  });
}

export function tenantDir(id) {
  const safe = String(id || '');
  if (!safe || !/^[A-Za-z0-9_-]+$/.test(safe)) {
    throw new Error(`Invalid tenant id: ${safe || '<empty>'}`);
  }
  return path.join(TENANTS_DIR, safe);
}

export async function loadTenant(id) {
  const file = path.join(tenantDir(id), 'tenant.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeTenantFile(tenant) {
  const dir = tenantDir(tenant.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'vault'), { recursive: true });
  const tenantFile = path.join(dir, 'tenant.json');
  const tenantTemp = `${tenantFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tenantTemp, `${JSON.stringify(tenant, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tenantTemp, tenantFile);
}

function assertTenantIdentityAvailable(index, tenant) {
  const phoneKey = tenant.phone ? tenantIdFromPhone(tenant.phone) : null;
  const jidKey = tenant.jid ? String(tenant.jid) : null;
  if (phoneKey && index.byPhone[phoneKey] && index.byPhone[phoneKey] !== tenant.id) {
    throw new Error(`Phone ${phoneKey} is already assigned to tenant ${index.byPhone[phoneKey]}`);
  }
  if (jidKey && index.byJid[jidKey] && index.byJid[jidKey] !== tenant.id) {
    throw new Error(`JID ${jidKey} is already assigned to tenant ${index.byJid[jidKey]}`);
  }
}

function indexTenant(index, tenant) {
  for (const [mapName, currentKey] of [
    ['byJid', tenant.jid ? String(tenant.jid) : null],
    ['byPhone', tenant.phone ? tenantIdFromPhone(tenant.phone) : null],
  ]) {
    for (const [key, mapped] of Object.entries(index[mapName])) {
      if (mapped === tenant.id && key !== currentKey) delete index[mapName][key];
    }
  }
  if (tenant.jid) index.byJid[String(tenant.jid)] = tenant.id;
  if (tenant.phone) index.byPhone[tenantIdFromPhone(tenant.phone)] = tenant.id;
}

export async function saveTenant(tenant) {
  await withTenantIndexLock(async () => {
    const index = await readTenantIndex();
    assertTenantIdentityAvailable(index, tenant);
    await writeTenantFile(tenant);
    indexTenant(index, tenant);
    await writeTenantIndex(index);
  });
  return tenant;
}

/** Atomically reserve one stable tenant identity for a phone/JID pair. */
export async function claimTenantIdentity({
  phone,
  jid,
  requestedId = null,
  defaults = {},
  idFactory = generateTenantId,
} = {}) {
  const phoneKey = phone ? tenantIdFromPhone(phone) : null;
  const jidKey = jid ? String(jid) : null;
  if (!phoneKey && !jidKey) throw new Error('Tenant identity requires a phone or JID');

  return withTenantIndexLock(async () => {
    const index = await readTenantIndex();
    const mappedIds = new Set([
      phoneKey ? index.byPhone[phoneKey] : null,
      jidKey ? index.byJid[jidKey] : null,
    ].filter(Boolean));
    if (mappedIds.size > 1) {
      throw new Error(`Phone/JID identity conflict: ${[...mappedIds].join(', ')}`);
    }

    const mappedId = [...mappedIds][0] || null;
    if (mappedId) {
      const existing = await loadTenant(mappedId);
      if (!existing) {
        throw new Error(`Tenant index points to missing tenant ${mappedId}; repair the index before signup`);
      }
      return existing;
    }

    let id = requestedId;
    if (id) {
      const existing = await loadTenant(id);
      if (existing) {
        const repaired = { ...existing, phone: phone || existing.phone, jid: jid || existing.jid };
        assertTenantIdentityAvailable(index, repaired);
        await writeTenantFile(repaired);
        indexTenant(index, repaired);
        await writeTenantIndex(index);
        return repaired;
      }
    } else {
      const reservedIds = new Set([
        ...Object.values(index.byPhone),
        ...Object.values(index.byJid),
      ]);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = idFactory();
        if (!reservedIds.has(candidate) && !(await loadTenant(candidate))) {
          id = candidate;
          break;
        }
      }
      if (!id) throw new Error('Unable to allocate a unique tenant UID after 100 attempts');
    }

    const tenant = { ...defaults, id, phone: phone || null, jid: jid || null };
    assertTenantIdentityAvailable(index, tenant);
    await writeTenantFile(tenant);
    indexTenant(index, tenant);
    await writeTenantIndex(index);
    return tenant;
  });
}

export async function findTenantByJid(jid) {
  return withTenantIndexLock(async () => {
    const index = await readTenantIndex();
    const id = index.byJid[jid];
    if (!id) return null;
    return loadTenant(id);
  });
}

export async function findTenantByPhone(phone) {
  const normalized = tenantIdFromPhone(phone);
  return withTenantIndexLock(async () => {
    const index = await readTenantIndex();
    const mapped = index.byPhone[normalized];
    return mapped ? loadTenant(mapped) : null;
  });
}

export async function listTenants() {
  const index = await readTenantIndex();
  const ids = [...new Set([
    ...Object.values(index.byPhone),
    ...Object.values(index.byJid),
  ])];
  const tenants = [];
  for (const id of ids) {
    const t = await loadTenant(id);
    if (t) tenants.push(t);
  }
  return tenants;
}

/** Remove tenant folder + index entries (tests / ops cleanup). */
export async function deleteTenant(id) {
  const existing = await loadTenant(id);
  await updateTenantIndex((index) => {
    if (existing?.jid) delete index.byJid[existing.jid];
    if (existing?.phone) delete index.byPhone[tenantIdFromPhone(existing.phone)];
    for (const [phone, mapped] of Object.entries(index.byPhone)) {
      if (mapped === id) delete index.byPhone[phone];
    }
    for (const [jid, mapped] of Object.entries(index.byJid)) {
      if (mapped === id) delete index.byJid[jid];
    }
  });
  await fs.rm(tenantDir(id), { recursive: true, force: true });
}
