/** How often a tenant actually returns, from their own transcript. */
import { MIN_TYPICAL_GAP_MS } from '../openclaw/admission.mjs';

const SAMPLE = 60;
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

/** p75 of recent inbound gaps: three quarters of their messages arrive within
 *  this long of the previous one. */
export function typicalGapMs(store, conversationId, { now = Date.now() } = {}) {
  const key = `${store.tenantId}:${conversationId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let measured = null;
  try {
    const rows = store.db
      .prepare(
        `SELECT created_at FROM messages
          WHERE conversation_id = ? AND direction = 'inbound'
          ORDER BY sequence DESC LIMIT ?`,
      )
      .all(conversationId, SAMPLE);
    const ts = rows.map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i += 1) gaps.push(ts[i] - ts[i - 1]);
    if (gaps.length >= 4) {
      gaps.sort((a, b) => a - b);
      measured = gaps[Math.floor(gaps.length * 0.75)];
    }
  } catch {
    // no store, or unreadable: the floor is the honest answer
  }

  const value = Math.max(MIN_TYPICAL_GAP_MS, Number(measured) || MIN_TYPICAL_GAP_MS);
  cache.set(key, { at: now, value });
  return value;
}

export function forgetRhythm(tenantId) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${tenantId}:`)) cache.delete(key);
}
