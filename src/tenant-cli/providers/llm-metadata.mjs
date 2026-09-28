import { readVaultRecord, updateVaultRecord } from '../storage/vault-store.mjs';

const FORBIDDEN_ANTHROPIC_SECRET_KEYS = new Set([
  'anthropicApiKey',
  'claudeCodeOauthToken',
  'claudeCodeRefreshToken',
]);

export async function loadLlmMetadata(tenantId) {
  return readVaultRecord(tenantId, 'llm-auth', { migratePlaintext: false });
}

export async function updateLlmMetadata(tenantId, patch) {
  return updateVaultRecord(tenantId, 'llm-auth', async (current) => {
    const next = {
      ...(current || {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    for (const [key, value] of Object.entries(next)) {
      if (value == null || FORBIDDEN_ANTHROPIC_SECRET_KEYS.has(key)) delete next[key];
    }
    return next;
  });
}
