import { loadTenant, saveTenant } from './tenants.mjs';
import { openTenantStore } from './tenant-data/store.mjs';
import { latestSequence } from './tenant-data/context-store.mjs';

export function sessionUserFor(tenant, to) {
  // Persisted OpenClaw identity. Changing this abandons existing sessions.
  const base = `rocky-${to || 'default'}`;
  const epoch = Number(tenant?.sessionEpoch || 0);
  return epoch > 0 ? `${base}#${epoch}` : base;
}

export async function startNewSession(tenantId) {
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  const epoch = Number(tenant.sessionEpoch || 0) + 1;

  // Where the new session starts. Without it a cold container replays the
  // transcript across the boundary and re-injects the conversation the user
  // just ended — the reset would only hold while the container stayed warm.
  let fromSequence = Number(tenant.sessionFromSequence || 0);
  let store = null;
  try {
    store = openTenantStore(tenantId);
    fromSequence = latestSequence(store, tenantId) || fromSequence;
  } catch (err) {
    console.warn(`[session] ${tenantId}: could not read the transcript head — ${err?.message || err}`);
  } finally {
    store?.db?.close?.();
  }

  await saveTenant({ ...tenant, sessionEpoch: epoch, sessionFromSequence: fromSequence });
  return { epoch, fromSequence };
}
