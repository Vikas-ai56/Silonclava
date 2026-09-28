import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../file-lock.mjs';
import { TENANTS_DIR } from '../../paths.mjs';
import { loadTenant } from '../../tenants.mjs';
import { DEFAULT_ROUTE_BACKEND, getRouteBackend } from '../registry.mjs';

function implicitRoute() {
  return { backend: getRouteBackend(DEFAULT_ROUTE_BACKEND).id, implicit: true };
}

const ROUTES_FILE = path.join(TENANTS_DIR, 'routes.json');
const ROUTES_LOCK_FILE = path.join(TENANTS_DIR, '.routes.lock');

async function readRoutes() {
  try {
    const parsed = JSON.parse(await fs.readFile(ROUTES_FILE, 'utf8'));
    return {
      routes: parsed?.routes && typeof parsed.routes === 'object' ? parsed.routes : {},
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { routes: {}, history: [] };
    throw err;
  }
}

async function writeRoutes(routes) {
  await fs.mkdir(TENANTS_DIR, { recursive: true });
  const temp = `${ROUTES_FILE}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, ROUTES_FILE);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function requireTenant(request) {
  const tenantId = String(request.target?.tenantId || '');
  if (!(await loadTenant(tenantId))) throw new Error(`Tenant not found: ${tenantId}`);
  return tenantId;
}

export async function handleResourceAction(request) {
  const { action } = request;
  const tenantId = await requireTenant(request);

  if (action === 'show') {
    const doc = await readRoutes();
    return {
      tenantId,
      mutating: false,
      result: doc.routes[tenantId] || implicitRoute(),
    };
  }

  if (action === 'set') {
    const backend = getRouteBackend(request.params.backend).id;
    return withFileLock(ROUTES_LOCK_FILE, async () => {
      const doc = await readRoutes();
      const previous = doc.routes[tenantId] || implicitRoute();
      if (previous.backend === backend) {
        return {
          tenantId,
          mutating: false,
          result: { previous, current: previous, unchanged: true },
        };
      }
      const changedAt = new Date().toISOString();
      const changeId = crypto.randomUUID();
      const next = { backend, updatedAt: changedAt, changeId };
      doc.history.push({
        id: changeId,
        operation: 'set',
        tenantId,
        previous,
        next,
        changedAt,
      });
      doc.routes[tenantId] = next;
      await writeRoutes(doc);
      return { tenantId, mutating: true, result: { previous, current: next } };
    });
  }

  if (action === 'rollback') {
    return withFileLock(ROUTES_LOCK_FILE, async () => {
      const doc = await readRoutes();
      const current = doc.routes[tenantId] || implicitRoute();
      if (current.rolledBackFrom) {
        return {
          tenantId,
          mutating: false,
          result: { current, alreadyRolledBack: true },
        };
      }
      const entry = [...doc.history].reverse().find((candidate) => {
        if (candidate.tenantId !== tenantId || candidate.operation === 'rollback') return false;
        if (current.changeId && candidate.id) return candidate.id === current.changeId;
        return candidate.next?.backend === current.backend;
      });
      if (!entry) throw new Error(`No route history for tenant ${tenantId}`);

      const changedAt = new Date().toISOString();
      const rollbackId = crypto.randomUUID();
      const rolledBackFrom = entry.id || `legacy:${entry.changedAt || 'unknown'}`;
      const next = {
        ...entry.previous,
        updatedAt: changedAt,
        rolledBackAt: changedAt,
        rolledBackFrom,
        changeId: rollbackId,
      };
      doc.history.push({
        id: rollbackId,
        operation: 'rollback',
        tenantId,
        previous: current,
        next,
        rolledBackFrom,
        changedAt,
      });
      doc.routes[tenantId] = next;
      await writeRoutes(doc);
      return { tenantId, mutating: true, result: { previous: current, current: next } };
    });
  }

  throw new Error(`Unsupported route action: ${action || '<empty>'}`);
}
