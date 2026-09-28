import { sealMessageBody, decryptBody } from './store.mjs';
import { TURN_STATE, TERMINAL_STATES } from './migrations.mjs';
import { StaleTurnResultError, asStaleIfRaced } from './queue-store.mjs';

/**
 * Persist-before-send (SPEC-phase3c §6, §7).
 *
 * The exact approved bytes are committed before anything is sent, so the
 * delivered message always equals the stored one after decryption. A policy,
 * encryption, or commit failure blocks the send rather than falling back to an
 * unrecorded response.
 */

const nowIso = () => new Date().toISOString();

/** Provider statuses that end a delivery. `failed`/`undelivered` are terminal
 *  for the attempt; a further attempt creates a new row. */
const TERMINAL_PROVIDER_STATUS = new Set(['delivered', 'read', 'failed', 'undelivered']);
const TERMINAL_SUCCESS = new Set(['delivered', 'read']);
const TERMINAL_FAILURE = new Set(['failed', 'undelivered']);

/** Rank so an out-of-order callback cannot move a delivery backwards (§6). */
const STATUS_RANK = {
  queued: 1, accepted: 1, scheduled: 1,
  sending: 2, sent: 3, delivered: 4, read: 5,
  failed: 6, undelivered: 6,
};

/**
 * Commit the approved response and move the turn to `response_saved`.
 *
 * Sealing runs the §7 policy guard and AES-GCM before the transaction opens; a
 * blocked class throws here and nothing is sent.
 */
export function saveResponse(store, turnId, text, options = {}) {
  const { db, tenantId } = store;
  const bodyCipher = sealMessageBody(tenantId, text);
  const at = nowIso();

  const run = db.transaction(() => {
    const turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
    if (!turn) throw new StaleTurnResultError('No such turn', { turnId });
    if (TERMINAL_STATES.includes(turn.state)) {
      throw new StaleTurnResultError('Turn already terminal; refusing to save a response', {
        turnId, state: turn.state,
      });
    }
    if (options.generation !== undefined &&
        turn.runtime_generation !== null &&
        turn.runtime_generation !== options.generation) {
      throw new StaleTurnResultError('Response came from a replaced container generation', {
        turnId, expected: turn.runtime_generation, actual: options.generation,
      });
    }

    const seq = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM messages WHERE conversation_id = ?')
      .get(turn.conversation_id).s;

    const messageId = Number(
      db.prepare(
        `INSERT INTO messages
           (conversation_id, sequence, direction, channel, channel_account,
            body_cipher, retention_class, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)`,
      ).run(
        turn.conversation_id, seq, options.channel || 'whatsapp',
        turn.recipient, bodyCipher, options.retentionClass || 'standard', at,
      ).lastInsertRowid,
    );

    // Assert the state the checks above were made against. Across processes
    // SQLITE_BUSY_SNAPSHOT aborts the whole transaction first — which also rolls
    // back the outbound row written just above, so it cannot be orphaned. This
    // predicate is the guard that survives if the read is moved out later.
    const moved = db.prepare(
      `UPDATE turns SET state = ?, response_message_id = ?, updated_at = ?
        WHERE id = ? AND state = ?`,
    ).run(TURN_STATE.RESPONSE_SAVED, messageId, at, turnId, turn.state);
    if (!moved.changes) {
      throw new StaleTurnResultError('Turn changed state while the response was being saved', {
        turnId, expected: turn.state,
      });
    }

    return { messageId, recipient: turn.recipient, requestId: turn.request_id };
  });
  try {
    return run();
  } catch (err) {
    throw asStaleIfRaced(err, { turnId });
  }
}

/** Record that a send is about to begin. After this point the model is never
 *  re-invoked — only the saved bytes are re-sent (§6). */
export function beginSend(store, turnId, outboundMessageId) {
  const { db } = store;
  const at = nowIso();
  const run = db.transaction(() => {
    // Claim the turn BEFORE writing the attempt row. The live send and the
    // boot resend can both reach a `response_saved` turn; whichever loses must
    // leave no trace, or an orphan `sending` row is committed for a send that
    // never happens and every later attempt number is wrong.
    const claimed = db.prepare(
      `UPDATE turns SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
    ).run(TURN_STATE.SEND_STARTED, at, turnId, TURN_STATE.RESPONSE_SAVED);
    if (!claimed.changes) return null;

    const attempt = db
      .prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS a FROM delivery_attempts WHERE outbound_message_id = ?')
      .get(outboundMessageId).a;
    db.prepare(
      `INSERT INTO delivery_attempts (outbound_message_id, attempt, status, attempted_at)
       VALUES (?, ?, 'sending', ?)`,
    ).run(outboundMessageId, attempt, at);
    return attempt;
  });
  return run();
}

/** Attach the provider's receipt to the attempt and finish the turn. */
export function recordSendResult(store, turnId, outboundMessageId, attempt, receipt) {
  const { db } = store;
  const at = nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE delivery_attempts
          SET provider_message_id = ?, status = ?, error_code = ?, attempted_at = ?
        WHERE outbound_message_id = ? AND attempt = ?`,
    ).run(
      receipt.providerMessageId ?? null,
      receipt.ok ? receipt.status || 'sent' : 'failed',
      receipt.ok ? null : String(receipt.errorCode || 'SEND_FAILED'),
      receipt.acceptedAt || at,
      outboundMessageId,
      attempt,
    );
    if (receipt.providerMessageId) {
      db.prepare('UPDATE messages SET external_message_id = ? WHERE id = ?')
        .run(receipt.providerMessageId, outboundMessageId);
    }
    // Provider *acceptance* is not delivery. Twilio returns `queued`/`sent`
    // synchronously and reports the real outcome later by status callback, so
    // completing here would make a subsequent `failed` callback unable to
    // correct the record (§6). The turn stays at `send_started` until a
    // definitive receipt arrives.
    const status = String(receipt.status || '').toLowerCase();
    let next = null;
    if (!receipt.ok) next = TURN_STATE.FAILED;
    else if (TERMINAL_SUCCESS.has(status)) next = TURN_STATE.COMPLETED;
    else if (TERMINAL_FAILURE.has(status)) next = TURN_STATE.FAILED;

    if (next) {
      // Only terminalise a turn still mid-send. Zero rows means a provider
      // status callback already settled it, which is allowed to win: it is a
      // definitive outcome and this one is only the send's own acceptance.
      db.prepare(
        `UPDATE turns SET state = ?, error_code = ?, updated_at = ?
          WHERE id = ? AND state = ?`,
      ).run(
        next,
        next === TURN_STATE.FAILED ? String(receipt.errorCode || 'SEND_FAILED') : null,
        at, turnId, TURN_STATE.SEND_STARTED,
      );
    } else {
      db.prepare('UPDATE turns SET updated_at = ? WHERE id = ?').run(at, turnId);
    }
  });
  run();
}

/**
 * The send began but no definitive receipt arrived. §6: mark
 * `delivery_unknown` and do **not** blindly resend.
 */
export function markDeliveryUnknown(store, turnId, outboundMessageId, attempt, reason) {
  const { db } = store;
  const at = nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE delivery_attempts SET status = 'unknown', error_code = ?, attempted_at = ?
        WHERE outbound_message_id = ? AND attempt = ?`,
    ).run(String(reason || 'NO_RECEIPT'), at, outboundMessageId, attempt);
    // A turn a provider callback already settled is not ambiguous, so only a
    // turn still mid-send is moved. Zero rows here is the correct outcome.
    db.prepare(
      `UPDATE turns SET state = ?, error_code = ?, updated_at = ?
        WHERE id = ? AND state = ?`,
    )
      .run(TURN_STATE.DELIVERY_UNKNOWN, String(reason || 'NO_RECEIPT'), at, turnId, TURN_STATE.SEND_STARTED);
  });
  run();
}

/**
 * Apply a provider status callback (§6).
 *
 * This is the one turn write that deliberately carries **no** prior-state
 * predicate. It exists to correct a record after the fact: a late `delivered`
 * moving a turn out of `delivery_unknown`, or a late `failed` correcting a
 * turn we already completed. Guarding it on the previous state would disable
 * exactly the correction it was built for. Monotonicity is enforced instead by
 * STATUS_RANK against the attempt's own status, which is the right axis —
 * a callback may not move a delivery backwards, but it may settle a turn.
 *
 * The event is appended first and always — it is an observation, and duplicates
 * are harmless. The current projection advances only on a valid forward
 * transition, so duplicate and out-of-order callbacks are idempotent and cannot
 * move a terminal state backwards.
 *
 * Correlation is by provider message id, never by phone number.
 */
export function applyProviderStatus(store, { providerMessageId, status, errorCode = null, detail = null }) {
  const { db } = store;
  const at = nowIso();
  const incoming = String(status || '').toLowerCase();

  const run = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT da.id, da.status, da.outbound_message_id, da.attempt, m.id AS message_id
           FROM delivery_attempts da
           JOIN messages m ON m.id = da.outbound_message_id
          WHERE da.provider_message_id = ?
          ORDER BY da.attempt DESC LIMIT 1`,
      )
      .get(providerMessageId);
    if (!row) return { applied: false, settled: false, reason: 'unknown_provider_message' };

    db.prepare(
      `INSERT INTO message_events (message_id, event_type, provider_code, detail, observed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.message_id, `status:${incoming}`, errorCode, detail, at);

    const currentRank = STATUS_RANK[row.status] || 0;
    const incomingRank = STATUS_RANK[incoming] || 0;
    if (incomingRank <= currentRank) {
      return { applied: false, settled: false, reason: 'out_of_order', current: row.status, incoming };
    }

    db.prepare('UPDATE delivery_attempts SET status = ?, error_code = ? WHERE id = ?')
      .run(incoming, errorCode, row.id);

    let settled = false;
    if (TERMINAL_PROVIDER_STATUS.has(incoming)) {
      settled = true;
      const failed = incoming === 'failed' || incoming === 'undelivered';
      // A terminal callback is authoritative and may correct an earlier
      // optimistic state, but the rank check above already guarantees it never
      // moves a delivery backwards.
      db.prepare(
        `UPDATE turns SET state = ?, error_code = ?, updated_at = ?
          WHERE response_message_id = ?`,
      ).run(
        failed ? TURN_STATE.FAILED : TURN_STATE.COMPLETED,
        failed ? errorCode : null,
        at,
        row.message_id,
      );
    }
    // `settled` tells the caller a turn just left the executing set. The lane
    // may have work queued behind it that nothing else will wake — this
    // callback arrives long after `executeTurn`'s finally has run.
    return { applied: true, status: incoming, settled };
  });
  return run();
}

/** Turns whose response is committed but not confirmed delivered — resend the
 *  saved bytes, never re-invoke the model (§6). */
export function turnsAwaitingSend(store) {
  return store.db
    .prepare(
      `SELECT id, request_id, recipient, response_message_id, state
         FROM turns WHERE state = '${TURN_STATE.RESPONSE_SAVED}' ORDER BY id`,
    )
    .all();
}

/**
 * A cron result: an outbound response with no inbound message behind it.
 *
 * It creates the turn already at `response_saved` and joins the ordinary send
 * path from there (§1.4b). The model work happened inside the container, so the
 * only steps it skips are inbound persistence and model invocation — it is
 * ledgered, policy-checked and delivery-tracked exactly like a user reply.
 */
export function saveCronResponse(store, { conversationId, recipient, text, runId, channel = 'whatsapp' }) {
  const { db, tenantId } = store;
  const bodyCipher = sealMessageBody(tenantId, text);
  const at = nowIso();
  const requestId = `cron_${runId}`;

  const run = db.transaction(() => {
    // A webhook retry must not deliver the same cron result twice.
    const existing = db.prepare('SELECT id, response_message_id FROM turns WHERE request_id = ?').get(requestId);
    if (existing) {
      return { turnId: existing.id, messageId: existing.response_message_id, recipient, duplicate: true };
    }

    const seq = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM messages WHERE conversation_id = ?')
      .get(conversationId).s;

    const messageId = Number(
      db.prepare(
        `INSERT INTO messages
           (conversation_id, sequence, direction, channel, channel_account,
            body_cipher, retention_class, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, 'standard', ?)`,
      ).run(conversationId, seq, channel, recipient, bodyCipher, at).lastInsertRowid,
    );

    const turnId = Number(
      db.prepare(
        `INSERT INTO turns
           (request_id, conversation_id, state, recipient, route,
            response_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'cron', ?, ?, ?)`,
      ).run(requestId, conversationId, TURN_STATE.RESPONSE_SAVED, recipient, messageId, at, at)
        .lastInsertRowid,
    );

    return { turnId, messageId, recipient, duplicate: false };
  });
  return run();
}

/** The exact committed bytes for a turn's response, decrypted.
 *  What is sent must equal this — that is the persist-before-send gate. */
export function committedResponseText(store, turnId) {
  const row = store.db
    .prepare(
      `SELECT m.body_cipher FROM turns t
         JOIN messages m ON m.id = t.response_message_id
        WHERE t.id = ?`,
    )
    .get(turnId);
  if (!row) return null;
  return decryptBody(store.tenantId, row.body_cipher);
}

/**
 * Record a file the agent delivered, with the provider's id for that message.
 * Text replies get this through `deliverResponse`; a media send bypasses the
 * turn ledger, so without this a user replying to a file they were sent quotes
 * a message that is not in the record and the reply cannot be resolved.
 */
export function recordOutboundMedia(store, { conversationId, channel, recipient, file, externalMessageId, at = new Date().toISOString() }) {
  const db = store.db;
  const body = sealMessageBody(store.tenantId, `[file sent: ${file}]`);
  const run = db.transaction(() => {
    const seq = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM messages WHERE conversation_id = ?')
      .get(conversationId).s;
    return Number(
      db.prepare(
        `INSERT INTO messages
           (conversation_id, sequence, direction, channel, channel_account,
            external_message_id, body_cipher, retention_class, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'standard', ?)`,
      ).run(conversationId, seq, channel, recipient, externalMessageId || null, body, at).lastInsertRowid,
    );
  });
  return run();
}

/**
 * Record the provider id of every part a committed reply was delivered as.
 *
 * The reply stays one `messages` row; these are the ids WhatsApp shows the user
 * as separate messages, and any of them can be the target of a reply gesture.
 */
export function recordMessageParts(store, outboundMessageId, providerMessageIds, at = nowIso()) {
  const ids = (providerMessageIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const { db } = store;
  const run = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO message_parts
         (message_id, part_index, provider_message_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    let n = 0;
    ids.forEach((pid, i) => { n += stmt.run(outboundMessageId, i, pid, at).changes; });
    return n;
  });
  return run();
}
