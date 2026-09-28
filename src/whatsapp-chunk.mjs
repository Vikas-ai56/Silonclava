/**
 * Splitting a long reply is ours to do, not the provider's.
 *
 * Twilio accepts a body over WhatsApp's limit and silently delivers it as
 * several messages, each its own Message resource with its own SID, while the
 * API response returns only one of them. Every SID we never see is a message
 * the user can reply to and we cannot resolve — and a reply to one of them
 * reaches the agent with the quoted text missing.
 *
 * So we cut the text ourselves and keep every part's id.
 */

/** Twilio's WhatsApp body limit is 1600; leave room for the part marker. */
export const WHATSAPP_BODY_LIMIT = 1500;

const FENCE = /^```/;

function splitLongLine(line, limit) {
  const out = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ +/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Cut on the largest boundary that fits: paragraph, then line, then word.
 * A fenced code block is kept whole where it fits, because splitting one
 * renders as broken monospace on both halves.
 *
 * @returns {string[]} one or more parts, each within `limit`. Never empty for
 *   non-blank input, so callers can treat the result as the message list.
 */
export function chunkForWhatsApp(text, limit = WHATSAPP_BODY_LIMIT) {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  if (body.length <= limit) return [body];

  const units = [];
  let fence = null;
  for (const block of body.split('\n\n')) {
    if (fence !== null) {
      fence.push(block);
      if (block.split('\n').some((l) => FENCE.test(l))) {
        units.push(fence.join('\n\n'));
        fence = null;
      }
      continue;
    }
    const opens = block.split('\n').filter((l) => FENCE.test(l)).length;
    if (opens % 2 === 1) fence = [block];
    else units.push(block);
  }
  if (fence !== null) units.push(fence.join('\n\n'));

  const parts = [];
  let current = '';
  const push = () => { if (current) { parts.push(current); current = ''; } };

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= limit) { current = candidate; continue; }
    push();
    if (unit.length <= limit) { current = unit; continue; }
    for (const line of unit.split('\n')) {
      for (const piece of (line.length > limit ? splitLongLine(line, limit) : [line])) {
        const next = current ? `${current}\n${piece}` : piece;
        if (next.length <= limit) current = next;
        else { push(); current = piece; }
      }
    }
  }
  push();
  return parts.length ? parts : [body.slice(0, limit)];
}
