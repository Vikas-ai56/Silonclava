/** Parse Anthropic's paste response, normally CODE#STATE. */
export function parseClaudeOAuthPaste(raw, { expectedState } = {}) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    if (/^https?:\/\//i.test(text)) {
      const url = new URL(text);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code) return { code: code.split('#')[0], state: state || expectedState || null };
    }
  } catch {
    // Not a URL; continue with paste formats.
  }

  const hash = text.match(/^([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/);
  if (hash) return { code: hash[1], state: hash[2] };

  const embedded = text.match(/([A-Za-z0-9_-]{8,})#([A-Za-z0-9_-]{8,})/);
  if (embedded) return { code: embedded[1], state: embedded[2] };

  if (expectedState && /^[A-Za-z0-9_-]{12,}$/.test(text) && !text.includes(' ')) {
    return { code: text, state: expectedState };
  }
  return null;
}

export function looksLikeClaudeOAuthPaste(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 800) return false;
  if (/^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/.test(text)) return true;
  if (/platform\.claude\.com\/oauth/i.test(text) && /code=/i.test(text)) return true;
  return /^[A-Za-z0-9_-]{20,}$/.test(text) && !/\s/.test(text);
}

