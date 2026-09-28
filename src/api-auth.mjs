import { timingSafeEqual } from 'node:crypto';

/**
 * Admin HTTP auth for /api/* (not WhatsApp).
 * Set ROCKY_API_TOKEN in env; clients send: Authorization: Bearer <token>
 */
export function getApiToken() {
  return String(process.env.ROCKY_API_TOKEN || '').trim();
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  try {
    return timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkApiAuth(req) {
  const expected = getApiToken();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'ROCKY_API_TOKEN is not configured — admin APIs are locked',
    };
  }
  const hdr = String(req.headers.authorization || '');
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const got = m ? m[1].trim() : '';
  if (!got || !safeEqual(got, expected)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
