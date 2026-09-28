/** Parse only explicit account/runtime connection requests from a channel. */
export function matchConnectIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return null;
  if (/^(connect|link)\s+(claude|anthropic)\b/.test(value)) {
    return { type: 'connect-llm', provider: 'claude' };
  }
  if (/^(connect|link)\s+(codex|openai)\b/.test(value)) {
    return { type: 'connect-llm', provider: 'codex' };
  }
  // External accounts are no longer matched here. The agent has `connect_account`
  // as a real tool (src/agent-mcp.mjs), so it understands any phrasing instead of
  // only the wordings we thought to anticipate — "connect calendar" worked,
  // "I'd like to hook up my calendar" did not. Provider login stays deterministic
  // above because it bootstraps the model that would otherwise do the matching.
  return null;
}
