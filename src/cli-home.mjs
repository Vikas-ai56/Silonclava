import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { tenantDir } from './tenants.mjs';

/**
 * Per-tenant CLI homes — Claude/Codex auth lives here, not the host ~/.claude or ~/.codex.
 *
 * tenants/<id>/cli-home/
 *   claude/     → CLAUDE_CONFIG_DIR
 *   codex/      → CODEX_HOME
 */
export function tenantCliHome(tenantId) {
  return path.join(tenantDir(tenantId), 'cli-home');
}

export function tenantClaudeConfigDir(tenantId) {
  return path.join(tenantCliHome(tenantId), 'claude');
}

export function tenantCodexHome(tenantId) {
  return path.join(tenantCliHome(tenantId), 'codex');
}

export async function ensureTenantCliHome(tenant) {
  const id = tenant.id;
  const home = tenantCliHome(id);
  const claudeDir = tenantClaudeConfigDir(id);
  const codexDir = tenantCodexHome(id);
  await fsPromises.mkdir(claudeDir, { recursive: true });
  await fsPromises.mkdir(codexDir, { recursive: true });

  tenant.cliHomePath = home;
  tenant.claudeConfigDir = claudeDir;
  tenant.codexHomePath = codexDir;

  return { home, claudeDir, codexDir };
}

/** Env vars injected into OpenClaw / CLI child for this tenant only. */
export function tenantCliEnv(tenant) {
  const id = tenant.id;
  const claudeDir = tenant.claudeConfigDir || tenantClaudeConfigDir(id);
  const codexDir = tenant.codexHomePath || tenantCodexHome(id);
  return {
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
  };
}
