import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { tenantDbSidecarPaths } from '../src/tenant-data/open.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { decryptValue } from '../src/privacy/aead.mjs';
import {
  VOICE_STATE,
  VOICE_TERMINAL_STATES,
  LEGAL_VOICE_TRANSITIONS,
  voiceStateRank,
  voiceCallSummary,
  deriveCallbackRef,
  VoiceCallError,
  requestCall,
  approveCall,
  rejectCall,
  markSubmitted,
  cancelCall,
  transitionCall,
  bindProviderCallId,
  recordProviderEvent,
  voiceCallById,
  voiceCallByCallbackRef,
  voiceCallDestination,
  voiceCallTranscript,
  voiceCallEvents,
  isLegalVoiceTransition,
} from '../src/tenant-data/voice-store.mjs';
import {
  createCall,
  getCall,
  stopCall,
  BlandError,
  isRetryableStatus,
  DEFAULT_CREATE_MAX_ATTEMPTS,
} from '../src/voice/bland-client.mjs';
import {
  verifyWebhookSignature,
  webhookFingerprint,
  parseWebhookEvent,
  withinReplayWindow,
  rawBodyBytes,
  EVENT_KIND,
} from '../src/voice/webhook.mjs';

const API_KEY = 'bland-test-key-never-logged-0123456789';
const CALLBACK_SECRET = 'callback-derivation-secret-for-tests';
const WEBHOOK_SECRET = 'bland-dashboard-webhook-signing-secret';
const DESTINATION = '+6591234567';

const ids = [];
const stores = [];

function freshTenant(tag) {
  const id = `br_voice_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}

function freshStore(tag) {
  const id = freshTenant(tag);
  const store = openTenantStore(id);
  stores.push(store);
  return store;
}

after(() => {
  for (const store of stores) {
    try {
      store.db.close();
    } catch {
      assert.ok(true);
    }
  }
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function providerSpy(responder) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    });
    return responder(requests.length, { url: String(url), init });
  };
  return { requests, fetchImpl };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

const acceptOneCall = () => providerSpy((n) => jsonResponse(200, {
  status: 'success',
  message: 'Call successfully queued.',
  call_id: `call-${n}`,
  batch_id: null,
}));

async function placeCall(store, { callKey, destination = DESTINATION, task }, fetchImpl) {
  const requested = requestCall(store, {
    callKey, callbackSecret: CALLBACK_SECRET, destination, task,
  });
  if (!requested.created) return { ...requested, placed: false, reason: 'already_requested' };

  approveCall(store, requested.callId, { approvalId: `approval-${callKey}` });
  markSubmitted(store, requested.callId, { providerCallId: null });

  const accepted = await createCall({
    apiKey: API_KEY,
    phoneNumber: destination,
    task,
    webhookUrl: `https://gateway.example/webhooks/bland/${requested.callbackRef}`,
    fetchImpl,
    sleepImpl: async () => {},
  });
  bindProviderCallId(store, requested.callId, accepted.providerCallId);
  return { ...requested, placed: true, providerCallId: accepted.providerCallId };
}

function signedDelivery(body, { secret = WEBHOOK_SECRET } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    rawBody,
    headers: {
      'X-Webhook-Signature': crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    },
  };
}

function ingestWebhook(store, callbackRef, delivery) {
  const verified = verifyWebhookSignature({
    rawBody: delivery.rawBody,
    headers: delivery.headers,
    secret: WEBHOOK_SECRET,
  });
  if (!verified.ok) return { accepted: false, reason: verified.reason };
  const event = parseWebhookEvent(delivery.rawBody);
  return {
    accepted: true,
    outcome: recordProviderEvent(store, {
      callbackRef,
      fingerprint: event.fingerprint,
      eventState: event.eventState,
      providerAt: event.providerAt,
      providerCallId: event.providerCallId,
      payload: event.payload,
      answeredBy: event.answeredBy,
      endedBy: event.endedBy,
      errorCode: event.errorCode,
      completedAt: event.completedAt,
      summary: event.summary,
      transcript: event.transcript,
    }),
  };
}

function postCallBody(overrides = {}) {
  return {
    call_id: 'call-1',
    c_id: 'call-1',
    completed: true,
    status: 'completed',
    queue_status: 'complete',
    answered_by: 'human',
    call_ended_by: 'ASSISTANT',
    error_message: null,
    summary: 'The counterparty confirmed Thursday.',
    concatenated_transcript: 'assistant: hello\nuser: yes, Thursday works',
    end_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('a voice call request is idempotent on its call key', () => {
  it('the same call key placed twice reaches the provider exactly once', async () => {
    const store = freshStore('once');
    const spy = acceptOneCall();

    const first = await placeCall(store, { callKey: 'ck-once', task: 'Confirm Thursday' }, spy.fetchImpl);
    const second = await placeCall(store, { callKey: 'ck-once', task: 'Confirm Thursday' }, spy.fetchImpl);

    assert.equal(first.placed, true, 'the first request is the one that dials');
    assert.equal(second.placed, false, 'a repeat of the same request must never dial again');
    assert.equal(second.callId, first.callId, 'both requests resolve to the same durable row');
    assert.equal(
      spy.requests.length,
      1,
      'a human must be called once; a second POST /calls is a second real phone call',
    );
    assert.equal(spy.requests[0].method, 'POST');
    assert.equal(spy.requests[0].body.phone_number, DESTINATION);
  });

  it('the derived callback reference is stable across a repeated request', () => {
    const store = freshStore('ref');
    const first = requestCall(store, {
      callKey: 'ck-ref', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ping',
    });
    const second = requestCall(store, {
      callKey: 'ck-ref', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ping',
    });
    assert.equal(second.callbackRef, first.callbackRef, 'the webhook URL must survive a crash and a retry');
    assert.equal(second.created, false);
  });

  it('the callback reference is unguessable without the secret', () => {
    const store = freshStore('secret');
    const mine = deriveCallbackRef('ck-secret', CALLBACK_SECRET);
    const theirs = deriveCallbackRef('ck-secret', 'a-secret-an-attacker-picked');
    assert.notEqual(
      mine,
      theirs,
      'if the reference did not depend on the secret, knowing a call key would mint a valid webhook URL',
    );
    assert.match(mine, /^[a-f0-9]{64}$/);

    requestCall(store, {
      callKey: 'ck-secret', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ping',
    });
    assert.throws(
      () => requestCall(store, {
        callKey: 'ck-secret', callbackSecret: 'a-secret-an-attacker-picked', destination: DESTINATION, task: 'Ping',
      }),
      (err) => err instanceof VoiceCallError && err.code === 'CALLBACK_REF_MISMATCH',
      'a request under a different secret must not silently adopt the existing call',
    );
  });

  it('reusing a call key for a different destination is refused, not silently ignored', () => {
    const store = freshStore('conflict');
    requestCall(store, {
      callKey: 'ck-conflict', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ping',
    });
    assert.throws(
      () => requestCall(store, {
        callKey: 'ck-conflict', callbackSecret: CALLBACK_SECRET, destination: '+6598765432', task: 'Ping',
      }),
      (err) => err instanceof VoiceCallError && err.code === 'CALL_KEY_CONFLICT',
      'returning the original row would dial a number the caller did not ask for',
    );
  });
});

describe('a rejected request never reaches the provider', () => {
  it('rejection is terminal and blocks submission before any network call', async () => {
    const store = freshStore('rejected');
    const spy = acceptOneCall();

    const requested = requestCall(store, {
      callKey: 'ck-rejected', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ask about pricing',
    });
    rejectCall(store, requested.callId, { reason: 'NOT_APPROVED' });

    assert.throws(
      () => markSubmitted(store, requested.callId, { providerCallId: null }),
      (err) => err instanceof VoiceCallError && err.code === 'ILLEGAL_VOICE_TRANSITION',
      'a rejected call must not be submittable',
    );
    assert.equal(spy.requests.length, 0, 'no HTTP request may be made for a rejected call');
    assert.equal(voiceCallById(store, requested.callId).state, VOICE_STATE.REJECTED);
  });

  it('an unapproved request cannot be submitted', () => {
    const store = freshStore('unapproved');
    const requested = requestCall(store, {
      callKey: 'ck-unapproved', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ask',
    });
    assert.throws(
      () => markSubmitted(store, requested.callId, { providerCallId: null }),
      (err) => err instanceof VoiceCallError && err.code === 'ILLEGAL_VOICE_TRANSITION',
      'requested -> submitted would skip the approval gate entirely',
    );
  });
});

describe('the transition set is explicit and closed', () => {
  it('every legal transition is declared and every undeclared one is refused', () => {
    const states = Object.values(VOICE_STATE);
    for (const from of states) {
      assert.ok(
        Array.isArray(LEGAL_VOICE_TRANSITIONS[from]),
        `${from} must declare its successors explicitly`,
      );
    }
    assert.equal(isLegalVoiceTransition(VOICE_STATE.REQUESTED, VOICE_STATE.APPROVED), true);
    for (const [from, successors] of Object.entries(LEGAL_VOICE_TRANSITIONS)) {
      for (const to of successors) {
        assert.ok(
          voiceStateRank(to) > voiceStateRank(from),
          `${from} -> ${to} must move the call forward, or the rank used to gate late enrichment is not a valid ordering`,
        );
      }
    }
    assert.deepEqual(
      [...VOICE_TERMINAL_STATES].sort(),
      [VOICE_STATE.CANCELLED, VOICE_STATE.COMPLETED, VOICE_STATE.FAILED, VOICE_STATE.REJECTED].sort(),
      'terminal means "declares no successors" — there is no second list to fall out of step',
    );
    assert.equal(isLegalVoiceTransition(VOICE_STATE.REQUESTED, VOICE_STATE.IN_PROGRESS), false);
    assert.equal(isLegalVoiceTransition(VOICE_STATE.COMPLETED, VOICE_STATE.RINGING), false);
    assert.equal(isLegalVoiceTransition(VOICE_STATE.SUBMITTED, VOICE_STATE.APPROVED), false);
  });

  it('an illegal transition throws and leaves the row untouched', () => {
    const store = freshStore('illegal');
    const requested = requestCall(store, {
      callKey: 'ck-illegal', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ask',
    });
    assert.throws(
      () => transitionCall(store, requested.callId, VOICE_STATE.IN_PROGRESS),
      (err) => err instanceof VoiceCallError && err.code === 'ILLEGAL_VOICE_TRANSITION',
    );
    assert.equal(
      voiceCallById(store, requested.callId).state,
      VOICE_STATE.REQUESTED,
      'a refused transition must not partially apply',
    );
  });

  it('a cancelled call cannot be resurrected', () => {
    const store = freshStore('cancelled');
    const requested = requestCall(store, {
      callKey: 'ck-cancelled', callbackSecret: CALLBACK_SECRET, destination: DESTINATION, task: 'Ask',
    });
    approveCall(store, requested.callId, { approvalId: 'a1' });
    cancelCall(store, requested.callId, { reason: 'OPERATOR_STOP' });
    assert.throws(
      () => transitionCall(store, requested.callId, VOICE_STATE.IN_PROGRESS),
      (err) => err instanceof VoiceCallError && err.code === 'ILLEGAL_VOICE_TRANSITION',
    );
  });
});

describe('provider events are idempotent and cannot move a call backwards', () => {
  it('the same webhook body delivered twice is recorded once and applied once', async () => {
    const store = freshStore('dupe');
    const placed = await placeCall(store, { callKey: 'ck-dupe', task: 'Confirm' }, acceptOneCall().fetchImpl);
    const delivery = signedDelivery(postCallBody());

    const first = ingestWebhook(store, placed.callbackRef, delivery);
    const second = ingestWebhook(store, placed.callbackRef, delivery);

    assert.equal(first.outcome.applied, true, 'the first delivery settles the call');
    assert.equal(second.outcome.duplicate, true, 'a provider retry is not a second outcome');
    assert.equal(second.outcome.applied, false);
    assert.equal(
      voiceCallEvents(store, placed.callId).length,
      1,
      'the fingerprint uniqueness constraint is what makes replay harmless',
    );
    assert.equal(voiceCallById(store, placed.callId).state, VOICE_STATE.COMPLETED);
  });

  it('a late ringing event after completion does not regress the state', async () => {
    const store = freshStore('ooo');
    const placed = await placeCall(store, { callKey: 'ck-ooo', task: 'Confirm' }, acceptOneCall().fetchImpl);

    ingestWebhook(store, placed.callbackRef, signedDelivery(postCallBody()));
    assert.equal(voiceCallById(store, placed.callId).state, VOICE_STATE.COMPLETED);

    const late = ingestWebhook(store, placed.callbackRef, signedDelivery(postCallBody({
      completed: false,
      status: null,
      queue_status: 'allocated',
      summary: null,
      concatenated_transcript: null,
      end_at: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    })));

    assert.equal(late.outcome.duplicate, false, 'a different body is a different event');
    assert.equal(late.outcome.applied, false, 'a stale lifecycle event must not be projected');
    assert.equal(late.outcome.reason, 'already_terminal');
    assert.equal(
      voiceCallById(store, placed.callId).state,
      VOICE_STATE.COMPLETED,
      'a completed call that later reports ringing is still completed',
    );
    assert.equal(
      voiceCallEvents(store, placed.callId).length,
      2,
      'the late event is still kept as evidence',
    );
  });

  it('an out-of-order event before any terminal state is recorded but not projected', async () => {
    const store = freshStore('rank');
    const placed = await placeCall(store, { callKey: 'ck-rank', task: 'Confirm' }, acceptOneCall().fetchImpl);

    const advanced = recordProviderEvent(store, {
      callbackRef: placed.callbackRef,
      fingerprint: 'fp-in-progress',
      eventState: VOICE_STATE.IN_PROGRESS,
      payload: { queue_status: 'started' },
    });
    assert.equal(advanced.applied, true, 'submitted -> in_progress is a real advance');

    const behind = recordProviderEvent(store, {
      callbackRef: placed.callbackRef,
      fingerprint: 'fp-ringing',
      eventState: VOICE_STATE.RINGING,
      payload: { queue_status: 'allocated' },
    });
    assert.equal(behind.applied, false, 'ringing after in_progress is a reordered delivery');
    assert.equal(behind.reason, 'out_of_order');
    assert.equal(voiceCallById(store, placed.callId).state, VOICE_STATE.IN_PROGRESS);
  });

  it('an out-of-order event cannot overwrite what a later event already recorded', async () => {
    const store = freshStore('regress');
    const placed = await placeCall(store, { callKey: 'ck-regress', task: 'Confirm' }, acceptOneCall().fetchImpl);

    recordProviderEvent(store, {
      callbackRef: placed.callbackRef,
      fingerprint: 'fp-live',
      eventState: VOICE_STATE.IN_PROGRESS,
      payload: { queue_status: 'started' },
      summary: 'the live summary',
      answeredBy: 'human',
    });

    const stale = recordProviderEvent(store, {
      callbackRef: placed.callbackRef,
      fingerprint: 'fp-stale-ring',
      eventState: VOICE_STATE.RINGING,
      payload: { queue_status: 'allocated' },
      summary: 'a stale summary from before the call connected',
      answeredBy: 'unknown',
    });

    assert.equal(stale.enriched, false, 'a reordered event must not write its older view over a newer one');
    assert.equal(voiceCallSummary(store, placed.callId), 'the live summary');
    assert.equal(voiceCallById(store, placed.callId).answeredBy, 'human');
  });

  it('a late event still enriches a terminal call when it does not regress it', async () => {
    const store = freshStore('enrich');
    const placed = await placeCall(store, { callKey: 'ck-enrich', task: 'Confirm' }, acceptOneCall().fetchImpl);

    ingestWebhook(store, placed.callbackRef, signedDelivery(postCallBody({
      summary: null,
      concatenated_transcript: null,
    })));
    assert.equal(voiceCallTranscript(store, placed.callId), null);

    const delayed = ingestWebhook(store, placed.callbackRef, signedDelivery(postCallBody({
      concatenated_transcript: 'assistant: hello\nuser: confirmed',
    })));
    assert.equal(delayed.outcome.applied, false, 'the state was already terminal');
    assert.equal(delayed.outcome.enriched, true, 'Bland’s delayed post-call payload must still land');
    assert.equal(voiceCallTranscript(store, placed.callId), 'assistant: hello\nuser: confirmed');
  });

  it('a webhook for a callback reference this tenant does not hold is not an error', () => {
    const store = freshStore('unknownref');
    const outcome = recordProviderEvent(store, {
      callbackRef: 'a'.repeat(64),
      fingerprint: 'fp-unknown',
      eventState: VOICE_STATE.COMPLETED,
      payload: {},
    });
    assert.equal(outcome.matched, false, 'an unknown callback must not create or mutate anything');
    assert.equal(outcome.reason, 'unknown_call');
  });

  it('a streamed lifecycle event carries no state, because Bland’s stream message is free text', () => {
    const event = parseWebhookEvent(JSON.stringify({
      message: 'Call connected',
      call_id: 'call-1',
      category: 'call',
      log_level: 'info',
    }));
    assert.equal(event.kind, EVENT_KIND.STREAM);
    assert.equal(
      event.eventState,
      null,
      'parsing an English sentence for lifecycle state would be a guess, not a signal',
    );
  });
});

describe('webhook signatures are verified over the exact received bytes', () => {
  const body = '{\n  "call_id": "call-1",\n  "status": "completed",\n  "completed": true\n}';
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');

  it('accepts the raw body Bland actually sent', () => {
    const result = verifyWebhookSignature({
      rawBody: body, headers: { 'X-Webhook-Signature': signature }, secret: WEBHOOK_SECRET,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.fingerprint, webhookFingerprint(body));
  });

  it('rejects a body that was parsed and re-stringified', () => {
    const restringified = JSON.stringify(JSON.parse(body));
    assert.notEqual(restringified, body, 'the fixture must actually differ once round-tripped');
    const result = verifyWebhookSignature({
      rawBody: restringified, headers: { 'X-Webhook-Signature': signature }, secret: WEBHOOK_SECRET,
    });
    assert.equal(
      result.ok,
      false,
      'verifying a re-serialised body would accept any attacker payload with the same fields',
    );
    assert.equal(result.reason, 'signature_mismatch');
  });

  it('refuses to verify an already-parsed object at all', () => {
    assert.throws(
      () => verifyWebhookSignature({
        rawBody: JSON.parse(body), headers: { 'X-Webhook-Signature': signature }, secret: WEBHOOK_SECRET,
      }),
      (err) => err.code === 'WEBHOOK_RAW_BODY_REQUIRED',
      'a caller that lost the raw bytes must fail loudly, not verify something else',
    );
    assert.throws(() => rawBodyBytes({ call_id: 'call-1' }), /exact bytes/);
  });

  it('rejects a tampered body, a wrong secret, a missing header and a malformed digest', () => {
    const tampered = body.replace('completed', 'failed');
    assert.equal(verifyWebhookSignature({
      rawBody: tampered, headers: { 'X-Webhook-Signature': signature }, secret: WEBHOOK_SECRET,
    }).reason, 'signature_mismatch');
    assert.equal(verifyWebhookSignature({
      rawBody: body, headers: { 'X-Webhook-Signature': signature }, secret: 'not-the-secret',
    }).reason, 'signature_mismatch');
    assert.equal(verifyWebhookSignature({
      rawBody: body, headers: {}, secret: WEBHOOK_SECRET,
    }).reason, 'missing_signature');
    assert.equal(verifyWebhookSignature({
      rawBody: body, headers: { 'X-Webhook-Signature': 'zz' }, secret: WEBHOOK_SECRET,
    }).reason, 'signature_mismatch');
    assert.equal(verifyWebhookSignature({
      rawBody: body, headers: { 'X-Webhook-Signature': signature }, secret: '',
    }).reason, 'missing_secret');
  });

  it('accepts the alternate header name Bland’s own docs also publish', () => {
    const result = verifyWebhookSignature({
      rawBody: body, headers: { 'X-Bland-Signature': signature }, secret: WEBHOOK_SECRET,
    });
    assert.equal(result.ok, true, 'the docs disagree on the header name, so both are accepted');
  });

  it('bounds the replay window on the timestamp inside the signed body', () => {
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    assert.equal(withinReplayWindow('2026-09-25T11:58:00.000Z', { now }).ok, true);
    assert.equal(
      withinReplayWindow('2026-09-25T10:00:00.000Z', { now }).reason,
      'outside_replay_window',
      'an hour-old signed payload replayed at us is not a fresh event',
    );
    assert.equal(withinReplayWindow(null, { now }).reason, 'missing_timestamp');
    assert.equal(withinReplayWindow('not-a-date', { now }).reason, 'malformed_timestamp');
  });
});

describe('one tenant cannot see another tenant’s calls', () => {
  it('a callback reference minted for tenant A resolves to nothing in tenant B', async () => {
    const a = freshStore('tenant_a');
    const b = freshStore('tenant_b');
    const placed = await placeCall(a, { callKey: 'ck-cross', task: 'Confirm' }, acceptOneCall().fetchImpl);

    assert.ok(voiceCallByCallbackRef(a, placed.callbackRef), 'tenant A still owns its own call');
    assert.equal(
      voiceCallByCallbackRef(b, placed.callbackRef),
      null,
      'a leaked callback URL must not address another tenant’s call',
    );

    const misdirected = ingestWebhook(b, placed.callbackRef, signedDelivery(postCallBody()));
    assert.equal(misdirected.outcome.matched, false, 'tenant B must not record tenant A’s outcome');
    assert.equal(voiceCallById(a, placed.callId).state, VOICE_STATE.SUBMITTED, 'and A is unaffected');
  });

  it('tenant A’s ciphertext does not decrypt under tenant B’s identity', async () => {
    const a = freshStore('aead_a');
    const b = freshStore('aead_b');
    const placed = await placeCall(a, { callKey: 'ck-aead', task: 'Confirm' }, acceptOneCall().fetchImpl);

    const row = a.db.prepare('SELECT destination_cipher FROM voice_calls WHERE id = ?').get(placed.callId);
    assert.equal(decryptValue(a.tenantId, 'voice_destination', JSON.parse(row.destination_cipher)), DESTINATION);
    assert.throws(
      () => decryptValue(b.tenantId, 'voice_destination', JSON.parse(row.destination_cipher)),
      /authentication failed/i,
      'the AAD binds the row to its tenant, so a copied database file leaks nothing',
    );
  });

  it('a ciphertext cannot be moved between columns of the same call', async () => {
    const store = freshStore('aad_column');
    const placed = await placeCall(store, { callKey: 'ck-aad', task: 'Confirm Thursday' }, acceptOneCall().fetchImpl);
    const row = store.db
      .prepare('SELECT destination_cipher, task_cipher FROM voice_calls WHERE id = ?')
      .get(placed.callId);
    assert.throws(
      () => decryptValue(store.tenantId, 'voice_task', JSON.parse(row.destination_cipher)),
      /authentication failed/i,
      'the destination is not readable as if it were the task',
    );
    assert.throws(
      () => decryptValue(store.tenantId, 'voice_destination', JSON.parse(row.task_cipher)),
      /authentication failed/i,
      'and the task is not readable as if it were the destination: each column binds its own AAD',
    );
  });
});

describe('sensitive call fields are sealed at rest', () => {
  it('the voice tables seal what they hold, even though the number is not a secret', async () => {
    const store = freshStore('sealed');
    const secretTask = 'Ask the counterparty to confirm the Thursday board slot';
    const placed = await placeCall(
      store, { callKey: 'ck-sealed', destination: DESTINATION, task: secretTask }, acceptOneCall().fetchImpl,
    );
    ingestWebhook(store, placed.callbackRef, signedDelivery(postCallBody({
      to: DESTINATION,
      concatenated_transcript: `assistant: calling ${DESTINATION}\nuser: confirmed`,
    })));

    assert.equal(voiceCallDestination(store, placed.callId), DESTINATION, 'the value is still recoverable');

    const files = Object.values(tenantDbSidecarPaths(store.tenantId));
    let scanned = 0;
    let sawCiphertext = false;
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      scanned += 1;
      const bytes = fs.readFileSync(file);
      if (bytes.includes(Buffer.from('_rockyVault', 'utf8'))) sawCiphertext = true;
      assert.equal(
        bytes.includes(Buffer.from(DESTINATION, 'utf8')),
        false,
        `the plaintext destination number is readable in ${path.basename(file)}`,
      );
      // This holds only because a fixture tenant has no message history. On a
      // real tenant the same number sits in cleartext in messages.channel_account
      // and turns.recipient, because that is the conversation's own address.
      // What this test actually proves is that the VOICE tables add no new
      // cleartext copy, not that the number is secret anywhere in the database.
      assert.equal(
        bytes.includes(Buffer.from(secretTask, 'utf8')),
        false,
        `the plaintext call task is readable in ${path.basename(file)}`,
      );
      assert.equal(
        bytes.includes(Buffer.from('user: confirmed', 'utf8')),
        false,
        `the plaintext transcript is readable in ${path.basename(file)}`,
      );
    }
    assert.ok(scanned > 0, 'the scan must actually have read the database files');
    assert.ok(
      sawCiphertext,
      'the rows must already be on disk, or this scan would pass by finding nothing at all',
    );
  });
});

describe('the Bland adapter never retries a call into existence', () => {
  it('creation is single-attempt by default, because Bland documents no idempotency key', async () => {
    assert.equal(DEFAULT_CREATE_MAX_ATTEMPTS, 1, 'a retried POST /calls places a second real call');
    const spy = providerSpy(() => jsonResponse(503, { status: 'error', message: 'upstream unavailable' }));
    await assert.rejects(
      createCall({
        apiKey: API_KEY,
        phoneNumber: DESTINATION,
        task: 'Confirm',
        webhookUrl: 'https://gateway.example/webhooks/bland/ref',
        fetchImpl: spy.fetchImpl,
        sleepImpl: async () => {},
      }),
      (err) => err instanceof BlandError && err.placementUncertain === true,
      'a 5xx leaves it unknown whether the phone rang, and that must be a first-class field',
    );
    assert.equal(spy.requests.length, 1, 'exactly one POST was made');
  });

  it('classifies retryability as a field, not as parsed prose', async () => {
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(418), false);
    assert.equal(isRetryableStatus(408), true);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);

    const spy = providerSpy(() => jsonResponse(401, {
      data: null, errors: [{ error: 'AUTH_FAILURE', message: 'Unauthorized' }],
    }));
    await assert.rejects(
      getCall({ apiKey: API_KEY, providerCallId: 'call-1', fetchImpl: spy.fetchImpl, sleepImpl: async () => {} }),
      (err) => err.retryable === false && err.status === 401,
    );
    assert.equal(spy.requests.length, 1, 'a terminal status must not be retried');
  });

  it('retries a read until it succeeds, within the bound', async () => {
    const spy = providerSpy((n) => (n < 3
      ? jsonResponse(429, { status: 'error', message: 'Rate limit exceeded' }, { 'retry-after': '0' })
      : jsonResponse(200, { call_id: 'call-1', status: 'completed', completed: true })));
    const call = await getCall({
      apiKey: API_KEY, providerCallId: 'call-1', fetchImpl: spy.fetchImpl, sleepImpl: async () => {},
    });
    assert.equal(call.status, 'completed');
    assert.equal(spy.requests.length, 3, 'reads are safe to retry and must be');
  });

  it('stops retrying at the bound', async () => {
    const spy = providerSpy(() => jsonResponse(500, { status: 'error', message: 'boom' }));
    await assert.rejects(
      stopCall({
        apiKey: API_KEY, providerCallId: 'call-1', maxAttempts: 2,
        fetchImpl: spy.fetchImpl, sleepImpl: async () => {},
      }),
      (err) => err.attempts === 2 && err.retryable === true,
    );
    assert.equal(spy.requests.length, 2, 'retries are bounded');
  });

  it('treats a timeout as retryable and as placement-uncertain', async () => {
    const spy = providerSpy(async (n, { init }) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      setTimeout(() => resolve(jsonResponse(200, { call_id: `call-${n}` })), 5_000).unref?.();
    }));
    await assert.rejects(
      createCall({
        apiKey: API_KEY,
        phoneNumber: DESTINATION,
        task: 'Confirm',
        webhookUrl: 'https://gateway.example/webhooks/bland/ref',
        timeoutMs: 20,
        fetchImpl: spy.fetchImpl,
        sleepImpl: async () => {},
      }),
      (err) => err.retryable === true && err.placementUncertain === true && /timed out/.test(err.message),
    );
  });

  it('never puts the API key in a thrown error, and sends it as a bearer token', async () => {
    const spy = providerSpy(() => jsonResponse(400, {
      status: 'error', message: `bad request for key ${API_KEY}`,
    }));
    await assert.rejects(
      createCall({
        apiKey: API_KEY,
        phoneNumber: DESTINATION,
        task: 'Confirm',
        webhookUrl: 'https://gateway.example/webhooks/bland/ref',
        fetchImpl: spy.fetchImpl,
        sleepImpl: async () => {},
      }),
      (err) => !err.message.includes(API_KEY) && err.message.includes('[redacted]'),
    );
    assert.equal(
      spy.requests[0].headers.authorization,
      `Bearer ${API_KEY}`,
      'Bland documents Bearer as the current form',
    );
    assert.equal(
      JSON.stringify(spy.requests[0].body).includes(API_KEY),
      false,
      'the key belongs in the header only',
    );
  });

  it('truncates provider error detail instead of echoing an unbounded body', async () => {
    const spy = providerSpy(() => jsonResponse(400, { status: 'error', message: 'x'.repeat(5_000) }));
    await assert.rejects(
      getCall({ apiKey: API_KEY, providerCallId: 'call-1', fetchImpl: spy.fetchImpl, sleepImpl: async () => {} }),
      (err) => err.message.length < 400,
    );
  });

  it('refuses a destination that is not E.164 before any request is made', async () => {
    const spy = acceptOneCall();
    await assert.rejects(
      createCall({
        apiKey: API_KEY,
        phoneNumber: '91234567',
        task: 'Confirm',
        webhookUrl: 'https://gateway.example/webhooks/bland/ref',
        fetchImpl: spy.fetchImpl,
      }),
      /E.164/,
    );
    assert.equal(spy.requests.length, 0);
  });

  it('bounds the call duration it will ask the provider for', async () => {
    const spy = acceptOneCall();
    await assert.rejects(
      createCall({
        apiKey: API_KEY,
        phoneNumber: DESTINATION,
        task: 'Confirm',
        webhookUrl: 'https://gateway.example/webhooks/bland/ref',
        maxDurationMinutes: 600,
        fetchImpl: spy.fetchImpl,
      }),
      /maxDurationMinutes/,
    );
    assert.equal(spy.requests.length, 0, 'an unbounded call is refused locally');
  });

  it('does not subscribe to streamed events unless the caller asks', async () => {
    const spy = acceptOneCall();
    await createCall({
      apiKey: API_KEY,
      phoneNumber: DESTINATION,
      task: 'Confirm',
      webhookUrl: 'https://gateway.example/webhooks/bland/ref',
      fetchImpl: spy.fetchImpl,
    });
    assert.equal(
      Object.hasOwn(spy.requests[0].body, 'webhook_events'),
      false,
      'streamed events carry free-text lifecycle we deliberately do not consume',
    );
    assert.equal(spy.requests[0].body.record, false, 'recording is off unless explicitly consented to');
  });
});

describe('nothing in this slice is reachable by a model', () => {
  it('a model may ask for a call but never choose who is called', async () => {
    const registry = await fs.promises.readFile(new URL('../src/tenant-cli/registry.mjs', import.meta.url), 'utf8');
    assert.ok(registry.includes("['voice'"), 'the voice resource is registered');

    const { AGENT_TOOLS } = await import('../src/agent-mcp.mjs');
    const dial = AGENT_TOOLS.filter((t) => /call/i.test(t.name));
    assert.deepEqual(dial.map((t) => t.name), ['place_call'],
      'exactly one calling tool, so there is one place this property has to hold');

    const properties = Object.keys(dial[0].inputSchema.properties);
    assert.deepEqual(properties, ['task'],
      'a destination parameter is what a forwarded message or a poisoned document would '
      + 'fill in; the number must come from tenant state, never from the model');
    assert.equal(dial[0].inputSchema.additionalProperties, false,
      'a model must not be able to smuggle a number past the schema');

    const { getResourceDefinition } = await import('../src/tenant-cli/registry.mjs');
    const voice = getResourceDefinition('voice');
    assert.deepEqual([...voice.agentActions].sort(), ['call', 'list', 'status'],
      'the agent may place and inspect a call, but never stop or remove one');
    assert.equal(voice.tenantActions, undefined,
      'a tenant self-service surface must not be able to dial');

    const resource = await fs.promises.readFile(
      new URL('../src/tenant-cli/resources/voice.mjs', import.meta.url), 'utf8',
    );
    assert.ok(/fromAgent/.test(resource) && /tenant\.phone/.test(resource),
      'an agent-originated call must resolve its destination from tenant state');
    const { createTenantAgentClient } = await import('../src/tenant-cli/client.mjs');
    const client = createTenantAgentClient({ tenantId: 'br_guard' });
    assert.equal(client.voice().call.length, 1,
      'the agent call surface takes a task and nothing else: a model that cannot '
      + 'name a number cannot be talked into dialling a stranger');
    assert.equal(voice.tenantSelfService, false);
  });

  it('the approval transition is reachable only from the operator resource', async () => {
    const callers = [];
    const walk = async (dir) => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.mjs') && !full.endsWith('voice-store.mjs')) {
          if (/\bapproveCall\s*\(/.test(await fs.promises.readFile(full, 'utf8'))) callers.push(full);
        }
      }
    };
    await walk(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src'));
    assert.deepEqual(
      callers.map((f) => f.split('/src/')[1]),
      ['tenant-cli/resources/voice.mjs'],
      'the operator typing the command IS the human approval; any other caller would mean '
      + 'something can approve a real phone call with no person deciding',
    );
  });
});

describe('an agent-originated call resolves its own destination', () => {
  it('reads the grant from where the command layer puts it', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/tenant-cli/resources/voice.mjs', import.meta.url), 'utf8');
    assert.ok(!/request\.grant\b/.test(src),
      'authorizeTenantRequest carries the grant on request.authorization; reading request.grant '
      + 'made fromAgent always false, so the agent fell through to the operator path and was '
      + 'told to supply a number it has no way to supply');
    assert.ok(/request\.authorization\?\.kind === 'agent'/.test(src));
  });
});

describe('the call payload carries what makes the agent speak', () => {
  it('sends a model, because a call with none connects and says nothing', async () => {
    const spy = providerSpy(() => jsonResponse(200, { status: 'success', call_id: 'c1' }));
    const { createCall } = await import('../src/voice/bland-client.mjs');
    await createCall({
      apiKey: 'k', phoneNumber: '+919999999999', task: 'say hello',
      webhookUrl: 'https://x.test/hook', fetchImpl: spy.fetchImpl,
    });
    const sent = spy.requests[0].body;
    assert.ok(sent.model,
      'two live calls connected, were billed, and produced zero assistant turns because no '
      + 'model was sent; the Hermes payload that worked always included one');
    assert.ok(sent.voice, 'a voice is required for it to be heard');
    assert.equal(sent.task, 'say hello');
  });
});

describe('a call whose webhook never landed can still be recovered', () => {
  it('stop names the argument the client destructures', async () => {
    const { stopCall } = await import('../src/voice/bland-client.mjs');
    const spy = providerSpy(() => jsonResponse(200, { status: 'success' }));
    await stopCall({ apiKey: 'k', providerCallId: 'prov-abc', fetchImpl: spy.fetchImpl });
    assert.equal(spy.requests.length, 1,
      'passing callId instead of providerCallId threw before any request, so stop was a dead end');
    assert.match(spy.requests[0].url, /prov-abc/);
  });

  it('the ingress forwards the provider timestamps it already parsed', async () => {
    const fsp = await import('node:fs/promises');
    const src = await fsp.readFile(new URL('../src/voice/ingress.mjs', import.meta.url), 'utf8');
    assert.match(src, /providerAt:/,
      'parseWebhookEvent computes providerAt and completedAt; dropping them left provider_at '
      + 'NULL and a settled call indistinguishable from an open one by completed_at');
    assert.match(src, /completedAt:/);
  });

  it('reconcile is reachable by an operator and not by a model', async () => {
    const { getResourceDefinition } = await import('../src/tenant-cli/registry.mjs');
    const voice = getResourceDefinition('voice');
    assert.equal(voice.agentActions.has('reconcile'), false,
      'reconcile writes terminal state from provider data; a model must not drive it');
    const src = await (await import('node:fs/promises'))
      .readFile(new URL('../src/tenant-cli/resources/voice.mjs', import.meta.url), 'utf8');
    assert.match(src, /request\.action === 'reconcile'/, 'the operator action exists');
    assert.match(src, /getCall\(/,
      'getCall was exported and called from nowhere; the reconciler is what makes it real');
  });

  it('reconciling twice does not double-record', async () => {
    const store = freshStore('reconcile-idem');
    const placed = await placeCall(
      store, { callKey: 'ck-rec', destination: DESTINATION, task: 'Ping' }, acceptOneCall().fetchImpl,
    );
    const fingerprint = `reconcile:${placed.providerCallId || 'call-1'}:completed`;
    const once = recordProviderEvent(store, {
      callId: placed.callId, fingerprint, eventState: 'completed', payload: { reconciled: true },
    });
    const twice = recordProviderEvent(store, {
      callId: placed.callId, fingerprint, eventState: 'completed', payload: { reconciled: true },
    });
    assert.equal(once.duplicate, false);
    assert.equal(twice.duplicate, true,
      'a deterministic fingerprint means an operator can run reconcile as often as they like');
  });
});
