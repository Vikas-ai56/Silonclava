import { recycleTenantGateway } from '../../../openclaw/tenant-gateway.mjs';
import { saveTenant } from '../../../tenants.mjs';
import {
  claudeCredentialMetadata,
  claudeCredentialStatus,
  removeTenantClaudeCredentials,
  writeTenantClaudeCredentials,
} from './credentials.mjs';
import { looksLikeClaudeOAuthPaste, parseClaudeOAuthPaste } from './inbound.mjs';
import {
  createClaudeOAuthSession,
  exchangeClaudeOAuthCode,
  peekClaudeOAuthSession,
  peekClaudeOAuthSessionForTenant,
  takeClaudeOAuthSession,
} from './oauth.mjs';

export async function beginClaudeLogin(tenant, { replyJid } = {}) {
  const session = createClaudeOAuthSession({ tenantId: tenant.id, replyJid: replyJid || tenant.jid });
  return {
    provider: 'claude',
    authorizeUrl: session.authorizeUrl,
    pastePageUrl: session.pastePageUrl,
    message:
      `Open this link and approve your Claude subscription:\n${session.authorizeUrl}\n\n` +
      'Then paste the CODE#STATE authorization code back here.',
  };
}

export function inspectClaudeCallbackState(state) {
  return peekClaudeOAuthSession(state);
}

export function canCompleteClaudeLogin(tenantId, raw) {
  return Boolean(looksLikeClaudeOAuthPaste(raw) && peekClaudeOAuthSessionForTenant(tenantId));
}

export async function completeClaudeLogin(tenant, raw) {
  let session = null;
  const parsed = parseClaudeOAuthPaste(raw);
  if (parsed?.state) {
    session = peekClaudeOAuthSession(parsed.state);
    if (session && session.tenantId !== tenant.id) {
      throw new Error('That Claude login code belongs to a different workspace.');
    }
    if (session) session = takeClaudeOAuthSession(parsed.state, { tenantId: tenant.id });
  }
  if (!session) {
    const candidate = peekClaudeOAuthSessionForTenant(tenant.id);
    if (candidate) session = takeClaudeOAuthSession(candidate.oauthState, { tenantId: tenant.id });
  }
  if (!session) {
    throw new Error(
      'No pending Claude login for this code. Send “connect claude” again, open the new link, then paste the code.',
    );
  }
  const code = parsed?.code || parseClaudeOAuthPaste(raw, { expectedState: session.oauthState })?.code;
  if (!code) throw new Error('Could not read the Claude authorization code.');
  const tokens = await exchangeClaudeOAuthCode({
    code,
    state: session.oauthState,
    codeVerifier: session.codeVerifier,
  });
  await writeTenantClaudeCredentials(tenant.id, tokens);
  tenant.state = 'ACTIVE';
  tenant.updatedAt = new Date().toISOString();
  await saveTenant(tenant);
  await recycleTenantGateway(tenant.id);
  return {
    provider: 'claude',
    connected: true,
    replyJid: session.replyJid || tenant.jid,
    message: 'Claude subscription connected for your private workspace.\n\nMessage me again and I’ll start your assistant.',
  };
}

export async function claudeLoginStatus(tenantId) {
  const metadata = await claudeCredentialMetadata(tenantId);
  const credential = await claudeCredentialStatus(tenantId);
  return {
    provider: 'claude',
    connected: credential.connected,
    refreshable: credential.refreshable,
    degraded: credential.degraded,
    refreshOwner: 'native-claude-cli',
    diagnostic: credential.degraded
      ? 'Claude access token is present but cannot refresh; reconnect before it expires.'
      : null,
    accountEmail: metadata.claudeAccount?.email_address || null,
    accountUuid: metadata.claudeAccount?.uuid || null,
    organizationUuid: metadata.claudeOrganization?.uuid || null,
    expiresAt: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : null,
    credentialFile: metadata.claudeCredentialFile || '.credentials.json',
  };
}

export async function logoutClaude(tenantId) {
  await removeTenantClaudeCredentials(tenantId);
  await recycleTenantGateway(tenantId);
  return { provider: 'claude', connected: false, localDeleted: true };
}

