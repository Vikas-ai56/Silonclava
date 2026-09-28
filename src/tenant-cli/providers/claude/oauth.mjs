import crypto from 'node:crypto';
import { PUBLIC_BASE_URL } from '../../../config.mjs';
import {
  consumePendingAuth,
  createPendingAuth,
  listPendingAuthForTenant,
  peekPendingAuth,
} from '../../storage/pending-auth.mjs';

export const CLAUDE_OAUTH_CLIENT_ID =
  process.env.ROCKY_CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_URL =
  process.env.ROCKY_CLAUDE_OAUTH_AUTHORIZE_URL || 'https://claude.ai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_URL =
  process.env.ROCKY_CLAUDE_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_REDIRECT_URI =
  process.env.ROCKY_CLAUDE_OAUTH_REDIRECT_URI ||
  'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_OAUTH_SCOPE =
  process.env.ROCKY_CLAUDE_OAUTH_SCOPE ||
  'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';

const PENDING_TTL_MS = 60 * 60 * 1000;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function createClaudeOAuthSession({ tenantId, replyJid }) {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const oauthState = b64url(crypto.randomBytes(32));
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', oauthState);

  const authorizeUrl = url.toString();
  const pastePageUrl = `${PUBLIC_BASE_URL}/connect/claude/?state=${encodeURIComponent(oauthState)}`;
  createPendingAuth({
    provider: 'claude',
    tenantId,
    state: oauthState,
    ttlMs: PENDING_TTL_MS,
    payload: { replyJid, codeVerifier, oauthState, authorizeUrl, pastePageUrl },
  });
  return { oauthState, authorizeUrl, pastePageUrl };
}

export function peekClaudeOAuthSession(oauthState, { tenantId = null } = {}) {
  return peekPendingAuth('claude', oauthState, { tenantId });
}

export function takeClaudeOAuthSession(oauthState, { tenantId = null } = {}) {
  return consumePendingAuth('claude', oauthState, { tenantId });
}

export function peekClaudeOAuthSessionForTenant(tenantId) {
  return listPendingAuthForTenant('claude', tenantId)[0] || null;
}

export async function exchangeClaudeOAuthCode({ code, state, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code).trim(),
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
    state: String(state).trim(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Claude OAuth token response not JSON (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(
        data.error_description || data.error || data.message || `Claude OAuth HTTP ${response.status}`,
      );
    }
    if (!data.access_token) throw new Error('Claude OAuth response missing access_token');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

