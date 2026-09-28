import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { tenantClaudeConfigDir } from '../../../cli-home.mjs';
import {
  decryptVaultValue,
  encryptVaultValue,
  isEncryptedVaultEnvelope,
} from '../../storage/vault-crypto.mjs';
import { loadLlmMetadata, updateLlmMetadata } from '../llm-metadata.mjs';
import { CLAUDE_OAUTH_SCOPE } from './oauth.mjs';

const FORBIDDEN_ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
const FORBIDDEN_VAULT_KEYS = new Set([
  'anthropicApiKey',
  'claudeCodeOauthToken',
  'claudeCodeRefreshToken',
]);

export function stripAnthropicStaticEnv(source = {}) {
  const clean = { ...source };
  for (const key of FORBIDDEN_ANTHROPIC_ENV_KEYS) delete clean[key];
  return clean;
}

async function atomicWrite(file, raw) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temp, raw, { mode: 0o600 });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export async function writeTenantClaudeCredentials(tenantId, tokenResponse) {
  const dir = tenantClaudeConfigDir(tenantId);
  const scopes = String(tokenResponse.scope || CLAUDE_OAUTH_SCOPE).split(/\s+/).filter(Boolean);
  const expiresAt = Date.now() + Number(tokenResponse.expires_in || 28800) * 1000;
  const credential = {
    claudeAiOauth: {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || null,
      expiresAt,
      scopes,
    },
  };
  const credentialPath = path.join(dir, '.credentials.json');
  await atomicWrite(credentialPath, `${JSON.stringify(credential, null, 2)}\n`);
  await fs.rm(path.join(dir, 'credentials.json'), { force: true });

  const metadataPath = path.join(dir, '.claude.json');
  let metadata = {};
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch {
    // First login.
  }
  if (tokenResponse.account || tokenResponse.organization) {
    metadata.oauthAccount = {
      ...(metadata.oauthAccount || {}),
      accountUuid: tokenResponse.account?.uuid,
      emailAddress: tokenResponse.account?.email_address,
      organizationUuid: tokenResponse.organization?.uuid,
    };
  }
  metadata.hasCompletedOnboarding = true;
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const settingsPath = path.join(dir, 'settings.json');
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (settings?.env && typeof settings.env === 'object') {
      for (const key of FORBIDDEN_ANTHROPIC_ENV_KEYS) delete settings.env[key];
      if (Object.keys(settings.env).length === 0) delete settings.env;
      await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  await updateLlmMetadata(tenantId, {
    claudeProvider: 'subscription',
    claudeCredentialFile: '.credentials.json',
    claudeOauthExpiresAt: new Date(expiresAt).toISOString(),
    claudeAccount: tokenResponse.account || null,
    claudeOrganization: tokenResponse.organization || null,
    anthropicApiKey: null,
    claudeCodeOauthToken: null,
    claudeCodeRefreshToken: null,
  });
  return { expiresAt, scopes };
}

export async function claudeCredentialStatus(tenantId) {
  try {
    const raw = await fs.readFile(path.join(tenantClaudeConfigDir(tenantId), '.credentials.json'), 'utf8');
    const oauth = JSON.parse(raw)?.claudeAiOauth || {};
    const connected = Boolean(oauth.accessToken);
    const refreshable = connected && Boolean(oauth.refreshToken);
    return {
      connected,
      refreshable,
      degraded: connected && !refreshable,
      expiresAt: Number.isFinite(Number(oauth.expiresAt)) ? Number(oauth.expiresAt) : null,
    };
  } catch {
    return { connected: false, refreshable: false, degraded: false, expiresAt: null };
  }
}

export async function claudeReady(tenantId) {
  return (await claudeCredentialStatus(tenantId)).connected;
}

export function claudeCredentialPresentSync(tenantId) {
  try {
    const raw = fsSync.readFileSync(
      path.join(tenantClaudeConfigDir(tenantId), '.credentials.json'),
      'utf8',
    );
    return Boolean(JSON.parse(raw)?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

export async function claudeCredentialMetadata(tenantId) {
  return (await loadLlmMetadata(tenantId)) || {};
}

export async function removeTenantClaudeCredentials(tenantId) {
  const dir = tenantClaudeConfigDir(tenantId);
  await fs.rm(path.join(dir, '.credentials.json'), { force: true });
  await fs.rm(path.join(dir, 'credentials.json'), { force: true });
  await updateLlmMetadata(tenantId, {
    claudeProvider: null,
    claudeCredentialFile: null,
    claudeOauthExpiresAt: null,
    claudeAccount: null,
    claudeOrganization: null,
  });
}

async function readOptional(file) {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function restoreFile(file, raw) {
  if (raw === null) await fs.rm(file, { force: true });
  else await atomicWrite(file, raw);
}

export async function normalizeLegacyClaudeAuthAtDirectory(
  directory,
  { sourceTenantId, targetTenantId },
) {
  const claudeDir = path.join(directory, 'cli-home', 'claude');
  const canonical = path.join(claudeDir, '.credentials.json');
  const duplicate = path.join(claudeDir, 'credentials.json');
  const vault = path.join(directory, 'vault', 'llm-auth.json');
  const backups = {
    canonical: await readOptional(canonical),
    duplicate: await readOptional(duplicate),
    vault: await readOptional(vault),
  };
  const result = {
    credentialPromoted: false,
    canonicalReplaced: false,
    duplicateRemoved: false,
    vaultSecretsRemoved: [],
  };
  try {
    let canonicalValid = false;
    if (backups.canonical !== null) {
      const parsed = JSON.parse(backups.canonical.toString('utf8'));
      canonicalValid = Boolean(parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken);
    }
    if (backups.duplicate !== null) {
      if (!canonicalValid) {
        const parsed = JSON.parse(backups.duplicate.toString('utf8'));
        if (!parsed?.claudeAiOauth?.accessToken || !parsed?.claudeAiOauth?.refreshToken) {
          throw new Error(`Legacy Claude credential is not refreshable: ${duplicate}`);
        }
        await atomicWrite(canonical, backups.duplicate);
        result.credentialPromoted = true;
        result.canonicalReplaced = backups.canonical !== null;
        canonicalValid = true;
      }
      await fs.rm(duplicate, { force: true });
      result.duplicateRemoved = true;
    }
    if (backups.canonical !== null && !canonicalValid) {
      throw new Error(`Claude credential is not refreshable: ${canonical}`);
    }
    if (backups.vault !== null) {
      const stored = JSON.parse(backups.vault.toString('utf8'));
      const metadata = isEncryptedVaultEnvelope(stored)
        ? decryptVaultValue(sourceTenantId, 'llm-auth', stored)
        : stored;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error(`Invalid LLM auth vault: ${vault}`);
      }
      for (const key of FORBIDDEN_VAULT_KEYS) {
        if (!(key in metadata)) continue;
        delete metadata[key];
        result.vaultSecretsRemoved.push(key);
      }
      await atomicWrite(
        vault,
        `${JSON.stringify(encryptVaultValue(targetTenantId, 'llm-auth', metadata), null, 2)}\n`,
      );
    }
  } catch (err) {
    await restoreLegacyClaudeAuthAtDirectory(directory, backups).catch(() => {});
    throw err;
  }
  return { backups, result };
}

export async function restoreLegacyClaudeAuthAtDirectory(directory, backups) {
  if (!backups) return;
  await restoreFile(path.join(directory, 'cli-home', 'claude', '.credentials.json'), backups.canonical);
  await restoreFile(path.join(directory, 'cli-home', 'claude', 'credentials.json'), backups.duplicate);
  await restoreFile(path.join(directory, 'vault', 'llm-auth.json'), backups.vault);
}
