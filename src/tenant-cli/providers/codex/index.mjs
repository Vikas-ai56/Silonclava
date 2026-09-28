import fs from 'node:fs';
import path from 'node:path';
import { tenantCodexHome } from '../../../cli-home.mjs';
import { loadLlmMetadata } from '../llm-metadata.mjs';

export async function codexReady(tenantId) {
  const metadata = await loadLlmMetadata(tenantId);
  if (metadata?.openaiApiKey) return true;
  const dir = tenantCodexHome(tenantId);
  try {
    return ['auth.json', 'config.toml'].some((name) => fs.existsSync(path.join(dir, name)));
  } catch {
    return false;
  }
}

export function codexCredentialPresentSync(tenantId) {
  const dir = tenantCodexHome(tenantId);
  try {
    return ['auth.json', 'config.toml'].some((name) => fs.existsSync(path.join(dir, name)));
  } catch {
    return false;
  }
}

export async function legacyCodexEnv(tenantId) {
  const metadata = await loadLlmMetadata(tenantId);
  return metadata?.openaiApiKey ? { OPENAI_API_KEY: metadata.openaiApiKey } : {};
}

export function codexLoginHelp() {
  return (
    'New Codex/API-key connections are disabled. Ask the operator to migrate this workspace to Claude, ' +
    'then send: connect claude.'
  );
}
