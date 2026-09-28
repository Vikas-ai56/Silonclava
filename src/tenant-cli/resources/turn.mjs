import fs from 'node:fs';
import { loadTenant } from '../../tenants.mjs';
import { openTenantStore } from '../../tenant-data/store.mjs';
import { tenantDbPath } from '../../tenant-data/open.mjs';
import { TURN_STATE } from '../../tenant-data/migrations.mjs';
import { listTurnsByState } from '../../tenant-data/queue-store.mjs';

/**
 * Operator-only `tenant turn` (SPEC-phase3c §9).
 *
 * Read-only visibility into failed or ambiguous deliveries. There is
 * deliberately **no `resolve` action**: pre-commit failures re-execute
 * automatically, so there is no side-effect ambiguity for an operator to
 * settle. It returns only if write-capable tools are ever enabled (§6).
 *
 * Message bodies are never returned — this is not an export path.
 */
const ALLOWED_STATES = new Set(Object.values(TURN_STATE));

export async function handleResourceAction(request) {
  const tenantId = String(request.target?.tenantId || '');
  if (!(await loadTenant(tenantId))) throw new Error(`Tenant not found: ${tenantId}`);
  const action = request.action || '';

  if (action !== 'list') {
    if (action === 'resolve') {
      throw new Error(
        'turn resolve does not exist: pre-commit failures re-execute automatically (SPEC-phase3c §9)',
      );
    }
    throw new Error(`Unsupported turn action: ${action || '<empty>'}`);
  }

  if (!fs.existsSync(tenantDbPath(tenantId))) {
    return { tenantId, mutating: false, result: { turns: [] } };
  }

  const requested = String(request.params?.state
    // Parked-on-a-human is the state an operator most needs to see unprompted.
    || `${TURN_STATE.FAILED},${TURN_STATE.DELIVERY_UNKNOWN},${TURN_STATE.AWAITING_APPROVAL}`)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const st of requested) {
    if (!ALLOWED_STATES.has(st)) throw new Error(`Unknown turn state: ${st}`);
  }

  const store = openTenantStore(tenantId, { readonly: true });
  try {
    const turns = listTurnsByState(store, requested);
    return { tenantId, mutating: false, result: { states: requested, turns } };
  } finally {
    store.db.close();
  }
}
