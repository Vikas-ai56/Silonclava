import { decryptBody, sealMessageBody } from './store.mjs';
import { transcriptLine } from './transcript-label.mjs';
import { TURN_STATE, TERMINAL_STATES } from './migrations.mjs';

/**
 * Context assembly from Rocky's own transcript (SPEC-phase3c §7).
 *
 * OpenClaw's session is a fast path, not memory. §1.5 says runtime-native
 * history "may compact, prune, reset, or change format" — and under hibernation
 * with quarantine-on-migration, a cold session is now ordinary rather than rare.
 * Without this, the agent starts blank every time that happens while the full
 * conversation sits encrypted in `data/tenant.sqlite`.
 *
 * So the durable transcript is the memory, and the session is an optimisation.
 */

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');
const TERMINAL_LIST = sqlList(TERMINAL_STATES);

/** Bounded so a long history cannot grow the prompt without limit (§7). */
/** A quoted message alone reads without its surroundings, so replay the
 *  exchange it sat in: roughly three before and two after. */
export const QUOTE_BEFORE = Number(process.env.ROCKY_QUOTE_CONTEXT_BEFORE || 6);
export const QUOTE_AFTER = Number(process.env.ROCKY_QUOTE_CONTEXT_AFTER || 4);

export const DEFAULT_MAX_MESSAGES = Number(process.env.ROCKY_CONTEXT_MAX_MESSAGES || 20);
export const DEFAULT_MAX_CHARS = Number(process.env.ROCKY_CONTEXT_MAX_CHARS || 6000);

/**
 * Whether this turn needs transcript context injected.
 *
 * Decided entirely from state we own: if the last settled turn ran under a
 * different container generation, that container has been replaced and its
 * session may be gone. Reading OpenClaw's session files to find out would be
 * building on state we do not own (`PATTERNS.md` P8).
 *
 * @returns {{needed: boolean, reason: string}}
 */
// Deliberately still keyed on TERMINAL states only. A parked turn has not
// settled, so its generation is not a comparison point; and because the last
// settled turn is then older, any mismatch errs toward replaying more context
// rather than less. That is the safe direction, so this is left alone.
export function contextNeeded(store, conversationId, currentGeneration) {
  const prior = store.db
    .prepare(
      `SELECT runtime_generation AS gen FROM turns
        WHERE conversation_id = ? AND state IN (${TERMINAL_LIST})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId);

  if (!prior) return { needed: false, reason: 'no prior turn' };
  if (currentGeneration === undefined || currentGeneration === null) {
    return { needed: false, reason: 'no generation to compare' };
  }
  if (prior.gen === null) return { needed: true, reason: 'prior turn has no generation' };
  if (prior.gen !== currentGeneration) {
    return { needed: true, reason: `generation changed ${prior.gen} -> ${currentGeneration}` };
  }
  return { needed: false, reason: 'same container generation' };
}

/** Most recent messages, oldest-first, decrypted. Excludes the turn's own
 *  inbound messages, which the model is already being given. */
export function recentMessages(
  store,
  conversationId,
  { limit = DEFAULT_MAX_MESSAGES, excludeIds = [], fromSequence = 0 } = {},
) {
  const exclude = excludeIds.length ? ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
  const rows = store.db
    .prepare(
      `SELECT id, direction, body_cipher, created_at FROM messages
        WHERE conversation_id = ?${exclude} AND sequence > ?
        ORDER BY sequence DESC LIMIT ?`,
    )
    .all(conversationId, ...excludeIds, Number(fromSequence) || 0, limit);

  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      direction: r.direction,
      at: r.created_at,
      text: safeDecrypt(store.tenantId, r.body_cipher),
    }))
    .filter((m) => m.text);
}

function safeDecrypt(tenantId, cipher) {
  try {
    return String(decryptBody(tenantId, cipher) || '').trim();
  } catch {
    // A record we cannot decrypt must not break the turn; omit it.
    return '';
  }
}

export function latestCheckpoint(store, conversationId) {
  const row = store.db
    .prepare(
      `SELECT id, through_sequence, summary_cipher FROM context_checkpoints
        WHERE conversation_id = ? AND verified = 1
        ORDER BY through_sequence DESC LIMIT 1`,
    )
    .get(conversationId);
  if (!row) return null;
  const text = safeDecrypt(store.tenantId, row.summary_cipher);
  return text ? { id: row.id, throughSequence: row.through_sequence, text } : null;
}

export function saveCheckpoint(store, conversationId, summaryText, throughSequence) {
  const cipher = sealMessageBody(store.tenantId, summaryText);
  return Number(
    store.db
      .prepare(
        `INSERT INTO context_checkpoints
           (conversation_id, through_sequence, summary_cipher, verified, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run(conversationId, throughSequence, cipher, new Date().toISOString()).lastInsertRowid,
  );
}

/**
 * Build the context block to prepend to a cold turn.
 *
 * Checkpoint summary first (the older, compressed part), then the most recent
 * messages verbatim, newest last so the model reads into the present. Trimmed
 * from the oldest end to stay inside the character budget.
 *
 * @returns {{text: string, messages: number, usedCheckpoint: boolean}|null}
 */
export function assembleContext(store, conversationId, options = {}) {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const checkpoint = options.fromSequence ? null : latestCheckpoint(store, conversationId);
  let messages = recentMessages(store, conversationId, {
    limit: maxMessages,
    excludeIds: options.excludeIds || [],
    fromSequence: options.fromSequence || 0,
  });
  if (!messages.length && !checkpoint) return null;

  const render = (list) => list.map(transcriptLine).join('\n');

  let body = render(messages);
  // Drop from the oldest end until it fits; the newest exchanges matter most.
  while (messages.length > 1 && (checkpoint?.text.length || 0) + body.length > maxChars) {
    messages = messages.slice(1);
    body = render(messages);
  }

  const parts = [];
  if (checkpoint) parts.push(`Summary of earlier conversation:\n${checkpoint.text}`);
  if (body) parts.push(`Recent messages:\n${body}`);

  return {
    text:
      'Context from this conversation (your session was reset; this is the durable record):\n\n' +
      `${parts.join('\n\n')}\n\n---\n`,
    messages: messages.length,
    usedCheckpoint: Boolean(checkpoint),
  };
}

/** Highest message sequence in a conversation, for checkpoint bookkeeping. */
export function latestSequence(store, conversationId) {
  return (
    store.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM messages WHERE conversation_id = ?')
      .get(conversationId).s || 0
  );
}

export function interruptedTurnPreamble() {
  return (
    'Your previous attempt at this request was interrupted and may have partly ' +
    'completed. Before doing anything, check whether the work already exists — ' +
    'search the relevant service for it. If it is already done, say so and do ' +
    'not repeat it. If it is partly done, complete only what is missing. If you ' +
    'cannot determine either way, tell the user what you are unsure about and ' +
    'ask before acting.\n\n---\n'
  );
}

/**
 * The messages surrounding a quoted one, oldest first, excluding it. Bounded by
 * the session boundary so a quote near the edge cannot drag the ended
 * conversation back in.
 */
export function messagesAround(store, conversationId, sequence, options = {}) {
  const before = Number(options.before ?? QUOTE_BEFORE);
  const after = Number(options.after ?? QUOTE_AFTER);
  const fromSequence = Number(options.fromSequence || 0);
  const seq = Number(sequence);
  if (!Number.isFinite(seq)) return [];

  const earlier = store.db
    .prepare(
      `SELECT id, sequence, direction, body_cipher, created_at FROM messages
        WHERE conversation_id = ? AND sequence < ? AND sequence > ?
        ORDER BY sequence DESC LIMIT ?`,
    )
    .all(conversationId, seq, fromSequence, before)
    .reverse();

  const later = store.db
    .prepare(
      `SELECT id, sequence, direction, body_cipher, created_at FROM messages
        WHERE conversation_id = ? AND sequence > ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?`,
    )
    .all(conversationId, seq, fromSequence, after);

  return [...earlier, ...later]
    .map((r) => ({
      id: r.id,
      sequence: r.sequence,
      direction: r.direction,
      at: r.created_at,
      text: safeDecrypt(store.tenantId, r.body_cipher),
      side: r.sequence < seq ? 'before' : 'after',
    }))
    .filter((m) => m.text);
}
