/** WhatsApp bodies are capped by the provider (Twilio rejects >1600 chars with
 *  21617, asynchronously — the send call still returns success). */
export const MAX_BODY_CHARS = Number(process.env.ROCKY_MAX_BODY_CHARS || 1600);

/** Split at the largest natural boundary that fits: blank line, newline, then
 *  sentence, then a hard cut. Never splits mid-word unless a single word is
 *  longer than the limit. */
export function chunkMessage(text, limit = MAX_BODY_CHARS) {
  const body = String(text ?? '');
  if (body.length <= limit) return body ? [body] : [];

  const parts = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', ' ']) {
      cut = window.lastIndexOf(sep);
      if (cut > limit * 0.5) {
        cut += sep === '. ' ? 1 : sep.length;
        break;
      }
      cut = -1;
    }
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}
