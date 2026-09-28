import crypto from 'node:crypto';
import { sealMessageBody } from './store.mjs';
import { TURN_STATE, TERMINAL_STATES, WAITING_STATES } from './migrations.mjs';

const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');
const TERMINAL_LIST = sqlList(TERMINAL_STATES);
/** Parked turns are not executing, so they neither block the lane nor count
 *  as backlog. Everything here keys off that one distinction. */
const WAITING_LIST = sqlList(WAITING_STATES);
/** Everything that is NOT executing: pending, parked, or finished. The
 *  complement is exactly claimed / response_saved / send_started. */
const NOT_EXECUTING_LIST = sqlList([TURN_STATE.QUEUED, ...TERMINAL_STATES, ...WAITING_STATES]);

/**
 * Durable queue operations (SPEC-phase3c §5).
 *
 * Coalescing is a property of the database, not of a timer: an inbound message
 * arriving while a turn for the same conversation is still `queued` is attached
 * to that turn. Every source message keeps its own ordered `messages` row, so
 * the ledger never loses an individual message to coalescing — and unlike the
 * in-memory buffer it replaces, a burst that arrives during a restart is still
 * joined correctly on the way back up.
 *
 * Every function here is a short transaction. No model, network, Docker,
 * encryption, or channel call may run inside one (§4) — bodies are sealed
 * before the transaction opens.
 */

function nowIso() {
  return new Date().toISOString();
}

export function newRequestId() {
  return `req_${crypto.randomUUID()}`;
}


export function alreadyAccepted(store, { channel, channelAccount, externalMessageId }) {
  if (!externalMessageId) return false;
  const row = store.db
    .prepare(
      `SELECT 1 FROM messages
        WHERE channel = ? AND channel_account = ? AND external_message_id = ?`,
    )
    .get(channel, channelAccount, externalMessageId);
  return Boolean(row);
}

/**
 * Atomically dedupe the inbound message, store it, and either queue a new turn
 * or join the conversation's pending one.
 *
 * @returns {{messageId:number|null, turnId:number|null, requestId:string|null,
 *            deduped:boolean, coalescedInto:boolean}}
 */
export function recordInboundAndQueueTurn(store, inbound) {
  const { db, tenantId } = store;
  const {
    conversationId,
    channel,
    channelAccount,
    externalMessageId = null,
    replyToExternalId = null,
    attachments = null,
    body,
    retentionClass = 'standard',
    route = 'openclaw',
  } = inbound;

  // Sealing runs the policy guard and AES-GCM; both stay outside the
  // transaction so the write lock is held for as little as possible.
  const bodyCipher = sealMessageBody(tenantId, body);
  const at = nowIso();

  const run = db.transaction(() => {
    if (externalMessageId) {
      const existing = db
        .prepare(
          `SELECT id FROM messages
            WHERE channel = ? AND channel_account = ? AND external_message_id = ?`,
        )
        .get(channel, channelAccount, externalMessageId);
      // A provider retry is not a new message and must not produce a new turn.
      if (existing) {
        return { messageId: existing.id, turnId: null, requestId: null, deduped: true, coalescedInto: false };
      }
    }

    const next = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
      .get(conversationId).seq;

    const messageId = db
      .prepare(
        `INSERT INTO messages
           (conversation_id, sequence, direction, channel, channel_account,
            external_message_id, reply_to_external_id, attachments, body_cipher, retention_class, created_at)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, next, channel, channelAccount, externalMessageId, replyToExternalId,
           attachments && attachments.length ? JSON.stringify(attachments) : null,
           bodyCipher, retentionClass, at)
      .lastInsertRowid;

    // Join a turn that has not been claimed yet; never join a running one.
    const pending = db
      .prepare(
        `SELECT id, request_id FROM turns
          WHERE conversation_id = ? AND state = '${TURN_STATE.QUEUED}'
          ORDER BY id LIMIT 1`,
      )
      .get(conversationId);

    let turnId;
    let requestId;
    let coalescedInto = false;

    if (pending) {
      turnId = pending.id;
      requestId = pending.request_id;
      coalescedInto = true;
      db.prepare('UPDATE turns SET updated_at = ? WHERE id = ?').run(at, turnId);
    } else {
      requestId = newRequestId();
      // The recipient is frozen onto the turn here (§5). Delivery later reads
      // it from the turn, never from a module variable and never from an
      // address supplied by the tenant or the model.
      turnId = db
        .prepare(
          `INSERT INTO turns
             (request_id, conversation_id, state, recipient, route, created_at, updated_at)
           VALUES (?, ?, '${TURN_STATE.QUEUED}', ?, ?, ?, ?)`,
        )
        .run(requestId, conversationId, channelAccount, route, at, at).lastInsertRowid;
    }

    const position = db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM turn_messages WHERE turn_id = ?')
      .get(turnId).p;
    db.prepare('INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, ?, ?)')
      .run(turnId, messageId, position);

    return { messageId: Number(messageId), turnId: Number(turnId), requestId, deduped: false, coalescedInto };
  });

  return run();
}

/** Oldest queued turn, claimed atomically. Returns null when the lane is idle
 *  or already has a turn in flight — §5 allows one active turn per tenant. */
/**
 * @param {object} store
 * @param {{runtimeId?: string, generation?: number}} [runtime] stamped onto the
 *   turn at acquire and validated at completion (§5).
 */
export function claimNextTurn(store, runtime = {}) {
  const { db } = store;
  const run = db.transaction(() => {
    // One *executing* turn per tenant. A parked turn (waiting on a human, a
    // child run, or a retry timer) holds no runtime and must not stop the next
    // message being served — otherwise the lane is blocked for as long as the
    // user takes to answer, which is exactly the failure this slice removes.
    const executing = db
      .prepare(`SELECT id FROM turns WHERE state NOT IN (${NOT_EXECUTING_LIST}) LIMIT 1`)
      .get();
    if (executing) return null;

    const turn = db
      .prepare(`SELECT * FROM turns WHERE state = '${TURN_STATE.QUEUED}' ORDER BY id LIMIT 1`)
      .get();
    if (!turn) return null;

    const at = nowIso();
    // The claim names the state it was planned against. Measured: this predicate
    // does NOT fire across processes — SQLite aborts the transaction with
    // SQLITE_BUSY_SNAPSHOT first (see `asStaleIfRaced`). It is kept because the
    // read above sits in the same transaction today, and anything that later
    // moves it out makes this the only guard left.
    const claimed = db.prepare(
      `UPDATE turns
          SET state = ?, attempt = attempt + 1, runtime_id = ?, runtime_generation = ?,
              updated_at = ?
        WHERE id = ? AND state = ?`,
    ).run(
      TURN_STATE.CLAIMED,
      runtime.runtimeId ?? null,
      runtime.generation ?? null,
      at,
      turn.id,
      TURN_STATE.QUEUED,
    );
    // Someone else claimed it between the select and the update. Not an error:
    // the caller already handles "nothing to claim".
    if (!claimed.changes) return null;
    return {
      ...turn,
      state: TURN_STATE.CLAIMED,
      attempt: turn.attempt + 1,
      runtime_id: runtime.runtimeId ?? null,
      runtime_generation: runtime.generation ?? null,
    };
  });
  return run();
}

/** The inbound messages belonging to a turn, in ledger order. */
export function turnMessageIds(store, turnId) {
  return store.db
    .prepare('SELECT message_id FROM turn_messages WHERE turn_id = ? ORDER BY position')
    .all(turnId)
    .map((r) => r.message_id);
}

/**
 * A second writer — `bin/tenant.mjs` opens the same database — can commit
 * between this transaction's read and its write. In WAL mode SQLite aborts the
 * transaction with SQLITE_BUSY_SNAPSHOT rather than letting the write land, so
 * that error *is* the lost race. Callers are built to handle a stale result, so
 * it is reported as one instead of leaking a driver error code.
 *
 * Measured, not assumed: two connections, a read, an outside write, then the
 * guarded update. See `test/turn-state-cas.test.mjs`.
 */
export function asStaleIfRaced(err, detail) {
  const code = String(err?.code || '');
  if (code.startsWith('SQLITE_BUSY')) {
    return new StaleTurnResultError('Another writer changed the turn mid-transaction', {
      ...detail, sqliteCode: code,
    });
  }
  return err;
}

export class StaleTurnResultError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'StaleTurnResultError';
    this.code = 'STALE_TURN_RESULT';
    this.detail = detail;
  }
}

/**
 * Complete a turn, validating the envelope first (§5).
 *
 * A result carrying a stale generation came from a container that has since
 * been replaced, so the work behind it was abandoned; attributing it to the
 * current turn would deliver an answer to a request the user may have already
 * had re-executed. A result for an already-terminal turn is likewise rejected.
 */
export function completeTurn(store, turnId, outcome, expect = {}) {
  const { state, responseMessageId = null, errorCode = null } = outcome;
  const { db } = store;

  const run = db.transaction(() => {
    const turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
    if (!turn) throw new StaleTurnResultError('No such turn', { turnId });

    if (TERMINAL_STATES.includes(turn.state)) {
      throw new StaleTurnResultError('Turn already reached a terminal state', {
        turnId, state: turn.state, attempted: state,
      });
    }
    if (expect.requestId && turn.request_id !== expect.requestId) {
      throw new StaleTurnResultError('Result does not match the claimed request', {
        turnId, expected: expect.requestId, actual: turn.request_id,
      });
    }
    if (
      expect.generation !== undefined &&
      turn.runtime_generation !== null &&
      turn.runtime_generation !== expect.generation
    ) {
      throw new StaleTurnResultError('Result came from a replaced container generation', {
        turnId, expected: turn.runtime_generation, actual: expect.generation,
      });
    }

    // Assert the state the checks above were made against. Across processes
    // SQLITE_BUSY_SNAPSHOT fires before this can, so the live protection is the
    // catch below; this predicate is the guard that survives if the read is ever
    // moved out of the transaction.
    const moved = db.prepare(
      `UPDATE turns SET state = ?, response_message_id = ?, error_code = ?, updated_at = ?
        WHERE id = ? AND state = ?`,
    ).run(state, responseMessageId, errorCode, nowIso(), turnId, turn.state);
    if (!moved.changes) {
      throw new StaleTurnResultError('Turn changed state while the result was being recorded', {
        turnId, expected: turn.state, attempted: state,
      });
    }
    return { ...turn, state };
  });
  try {
    return run();
  } catch (err) {
    throw asStaleIfRaced(err, { turnId, attempted: state });
  }
}

/**
 * Restart recovery (§5): a turn left `running` by a crash is returned to
 * `queued` so it is re-executed in full from the original request. This is
 * safe only while the tool surface is enforced read-only (DECISIONS.md).
 */
export function recoverInterruptedTurns(store, { writesEnabled = false } = {}) {
  const at = nowIso();

  // A parked turn's wait lived where the crash was. `waiting_subrun` was
  // waiting on a child run and `retry_wait` on a timer — both were in memory
  // and are now gone, so those turns are as interrupted as a `claimed` one.
  //
  // `awaiting_approval` is different: its wait is a human, which the crash did
  // not destroy. Requeuing it would re-execute the turn and ask again. It is
  // left alone and surfaced instead. Nothing writes that state yet; the slice
  // that makes approvals durable owns its recovery.
  const INTERRUPTED = sqlList([
    TURN_STATE.CLAIMED,
    TURN_STATE.WAITING_SUBRUN,
    TURN_STATE.RETRY_WAIT,
  ]);

  const stranded = store.db
    .prepare(`SELECT COUNT(*) AS n FROM turns WHERE state = '${TURN_STATE.AWAITING_APPROVAL}'`)
    .get().n;
  if (stranded) {
    console.warn(
      `[recovery] ${stranded} turn(s) awaiting approval were left untouched — ` +
        'the approval outlives the crash, so re-executing would ask twice',
    );
  }

  // With write-capable tools reachable, re-execution is no longer safe: the
  // abandoned attempt may already have sent, created, or deleted something, and
  // re-running would repeat it (SPEC-phase3c §6 validity condition). Such turns
  // are marked for attention instead of being silently retried; they surface in
  // `tenant turn list`.
  if (writesEnabled) {
    const info = store.db
      .prepare(
        `UPDATE turns SET state = '${TURN_STATE.FAILED}', error_code = 'UNCERTAIN_WRITE',
                updated_at = ?
          WHERE state IN (${INTERRUPTED})`,
      )
      .run(at);
    if (info.changes) {
      console.warn(
        `[recovery] ${info.changes} interrupted turn(s) NOT re-executed: write-capable ` +
          'tools are enabled, so the attempt may already have had side effects',
      );
    }
    return 0;
  }

  const info = store.db
    .prepare(
      `UPDATE turns SET state = '${TURN_STATE.QUEUED}', updated_at = ?
        WHERE state IN (${INTERRUPTED})`,
    )
    .run(at);
  return info.changes;
}

/** Work the scheduler can actually pick up. A parked turn is not backlog: it
 *  is waiting on something outside the scheduler, and counting it would make
 *  `hasWork` permanently true and the depth a phantom. */
export function queueDepth(store) {
  return store.db
    .prepare(`SELECT COUNT(*) AS n FROM turns WHERE state NOT IN (${TERMINAL_LIST}, ${WAITING_LIST})`)
    .get().n;
}

export function hasWork(store) {
  return queueDepth(store) > 0;
}

/** Turns parked on something outside the scheduler, by what ends the wait.
 *  This is the "how much work is stuck on me?" query rule 9 exists to give. */
export function waitingDepth(store) {
  const rows = store.db
    .prepare(`SELECT state, COUNT(*) AS n FROM turns WHERE state IN (${WAITING_LIST}) GROUP BY state`)
    .all();
  const byState = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  return { total: rows.reduce((a, r) => a + r.n, 0), byState };
}

/**
 * The inbound messages of a turn, in ledger order, still encrypted.
 *
 * Decryption stays with the caller so this module never needs the tenant key;
 * the point is that SQL does not leak past this boundary.
 */
export function turnInboundRows(store, turnId) {
  return store.db
    .prepare(
      `SELECT m.id, m.body_cipher, m.channel, m.channel_account, m.sequence,
              m.reply_to_external_id, m.external_message_id
         FROM turn_messages tm
         JOIN messages m ON m.id = tm.message_id
        WHERE tm.turn_id = ?
        ORDER BY tm.position`,
    )
    .all(turnId);
}

/**
 * Attachments recorded against the messages in a turn. Kept out of the
 * transcript body: the body is what was *said*, this is where the files landed.
 */
export function turnAttachments(store, messageIds) {
  if (!messageIds?.length) return [];
  const rows = store.db
    .prepare(`SELECT attachments FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')})`)
    .all(...messageIds);
  const out = [];
  for (const row of rows) {
    if (!row.attachments) continue;
    try {
      out.push(...JSON.parse(row.attachments));
    } catch { /* a malformed row must not stop the turn */ }
  }
  return out;
}

/** The immutable envelope a response must be validated against before send. */
export function turnEnvelope(store, turnId) {
  const turn = store.db
    .prepare(
      `SELECT id, request_id, conversation_id, state, attempt, recipient, route,
              runtime_id, runtime_generation
         FROM turns WHERE id = ?`,
    )
    .get(turnId);
  if (!turn) return null;
  return {
    turnId: turn.id,
    requestId: turn.request_id,
    conversationId: turn.conversation_id,
    state: turn.state,
    attempt: turn.attempt,
    recipient: turn.recipient,
    route: turn.route,
    runtimeId: turn.runtime_id,
    generation: turn.runtime_generation,
  };
}

/** Turn counts by state, for operator status. Metadata only — no bodies. */
export function turnStateCounts(store) {
  return Object.fromEntries(
    store.db
      .prepare('SELECT state, COUNT(*) AS n FROM turns GROUP BY state')
      .all()
      .map((r) => [r.state, r.n]),
  );
}

export function schemaVersion(store) {
  return store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
}

/**
 * Turns in the given states, newest first. Deliberately selects no message
 * content: `tenant turn list` is operator visibility, not an export path.
 */
export function listTurnsByState(store, states, limit = 200) {
  if (!states.length) return [];
  const placeholders = states.map(() => '?').join(', ');
  return store.db
    .prepare(
      `SELECT id, request_id, state, attempt, route, error_code, created_at, updated_at
         FROM turns WHERE state IN (${placeholders})
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...states, limit);
}

/**
 * Shutdown classification (§8 step 4): a turn that had begun sending becomes
 * `delivery_unknown`, because the provider may already have delivered it and it
 * must never be blindly resent.
 */
export function staleSendStartedTurns(store, olderThanMs, { now = Date.now() } = {}) {
  const cutoff = new Date(now - olderThanMs).toISOString();
  return store.db
    .prepare(
      `SELECT id FROM turns
        WHERE state = '${TURN_STATE.SEND_STARTED}' AND updated_at < ?`,
    )
    .all(cutoff)
    .map((r) => r.id);
}

export function markOneSendStartedUnknown(store, turnId, reason) {
  const at = nowIso();
  return store.db
    .prepare(
      `UPDATE turns SET state = '${TURN_STATE.DELIVERY_UNKNOWN}', error_code = ?, updated_at = ?
        WHERE id = ? AND state = '${TURN_STATE.SEND_STARTED}'`,
    )
    .run(reason, at, turnId).changes;
}

export function markSendStartedUnknown(store, reason = 'SHUTDOWN') {
  const at = nowIso();
  const info = store.db
    .prepare(
      `UPDATE turns SET state = '${TURN_STATE.DELIVERY_UNKNOWN}', error_code = ?, updated_at = ?
        WHERE state = '${TURN_STATE.SEND_STARTED}'`,
    )
    .run(reason, at);
  return info.changes;
}
