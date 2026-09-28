import {
  deleteVaultRecord,
  readVaultRecord,
  updateVaultRecord,
  writeVaultRecord,
} from '../../storage/vault-store.mjs';

const RECORD = 'composio-mcp';

export function readTenantComposioState(tenantId) {
  return readVaultRecord(tenantId, RECORD);
}

export function saveTenantComposioState(tenantId, value) {
  return writeVaultRecord(tenantId, RECORD, value);
}

export function updateTenantComposioState(tenantId, update) {
  return updateVaultRecord(tenantId, RECORD, update);
}

export function deleteTenantComposioState(tenantId) {
  return deleteVaultRecord(tenantId, RECORD);
}
