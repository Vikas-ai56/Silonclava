import crypto from 'node:crypto';
import {
  blandApiKey, blandCallbackSecret, blandWebhookUrlFor,
} from '../../config.mjs';
import { createCall, getCall, stopCall } from '../../voice/bland-client.mjs';
import { callStatusToState } from '../../voice/webhook.mjs';
import {
  approveCall, bindProviderCallId, listVoiceCallsByState, recordProviderEvent,
  markFailed, markSubmitted, requestCall, voiceCallById, voiceCallEvents,
  voiceCallStateCounts, voiceCallSummary, VOICE_STATE,
} from '../../tenant-data/voice-store.mjs';
import { openTenantStore } from '../../tenant-data/store.mjs';
import { loadTenant } from '../../tenants.mjs';

const DEFAULT_OPENING = 'Hi, this is Rocky calling from BugleRock.';

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  if (!tenantId) throw new Error(`--tenant is required for voice ${request.action}`);
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

function withStore(tenantId, fn) {
  const store = openTenantStore(tenantId);
  try {
    return fn(store);
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}

function requireSecrets() {
  const apiKey = blandApiKey();
  if (!apiKey) throw new Error('BLAND_API_KEY is not configured');
  const callbackSecret = blandCallbackSecret();
  if (!callbackSecret) throw new Error('BLAND_CALLBACK_SECRET is not configured');
  return { apiKey, callbackSecret };
}

export async function handleResourceAction(request) {
  const tenant = await tenantFor(request);
  const params = request.params || {};

  if (request.action === 'list') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: withStore(tenant.id, (store) => ({
        counts: voiceCallStateCounts(store),
        open: listVoiceCallsByState(store, [
          VOICE_STATE.REQUESTED, VOICE_STATE.APPROVED, VOICE_STATE.SUBMITTED,
          VOICE_STATE.RINGING, VOICE_STATE.IN_PROGRESS,
        ]).map((c) => ({ id: c.callId, state: c.state, providerCallId: c.providerCallId })),
      })),
    };
  }

  if (request.action === 'status') {
    const callId = Number(params.call);
    if (!Number.isInteger(callId)) throw new Error('A numeric --call id is required');
    return {
      tenantId: tenant.id,
      mutating: false,
      result: withStore(tenant.id, (store) => {
        const call = voiceCallById(store, callId);
        if (!call) throw new Error(`No call ${callId} for this tenant`);
        return {
          id: call.callId,
          state: call.state,
          providerCallId: call.providerCallId,
          answeredBy: call.answeredBy,
          endedBy: call.endedBy,
          errorCode: call.errorCode,
          summary: voiceCallSummary(store, callId),
          events: voiceCallEvents(store, callId).map((e) => ({
            state: e.event_state, at: e.provider_at || e.received_at,
          })),
        };
      }),
    };
  }

  if (request.action === 'call') {
    const { apiKey, callbackSecret } = requireSecrets();
    const fromAgent = request.authorization?.kind === 'agent';
    const own = String(tenant.phone || tenant.jid || '').trim();
    const destination = fromAgent
      ? (own.startsWith('+') ? own : `+${own}`)
      : String(params.to || '').trim();
    if (fromAgent && !own) throw new Error('This tenant has no registered number to call');
    const task = String(params.task || '').trim();
    if (!destination) throw new Error('--to is required (E.164)');
    if (!task) throw new Error('--task is required');
    const callKey = String(params['call-key'] || '').trim() || crypto.randomUUID();

    const requested = withStore(tenant.id, (store) => requestCall(store, {
      callKey, callbackSecret, destination, task,
    }));

    if (!requested.created) {
      return {
        tenantId: tenant.id,
        mutating: false,
        auditParams: { callKey },
        result: { callId: requested.callId, state: requested.state, reused: true },
      };
    }

    const callbackRef = requested.callbackRef;
    withStore(tenant.id, (store) => {
      approveCall(store, requested.callId, {
        approvalId: `${request.authorization?.kind || 'operator'}:${tenant.id}`,
      });
      markSubmitted(store, requested.callId);
    });

    try {
      const placed = await createCall({
        apiKey,
        phoneNumber: destination,
        task,
        webhookUrl: blandWebhookUrlFor(callbackRef),
        firstSentence: String(params['first-sentence'] || '').trim() || DEFAULT_OPENING,
        metadata: { tenantId: tenant.id, callKey },
      });
      withStore(tenant.id, (store) => bindProviderCallId(store, requested.callId, placed.providerCallId));
      return {
        tenantId: tenant.id,
        mutating: true,
        auditParams: { callKey, destination: '[REDACTED]' },
        auditResult: { callId: requested.callId, providerCallId: placed.providerCallId },
        result: { callId: requested.callId, providerCallId: placed.providerCallId, state: VOICE_STATE.SUBMITTED },
      };
    } catch (err) {
      if (err?.placementUncertain) {
        return {
          tenantId: tenant.id,
          mutating: true,
          auditParams: { callKey },
          result: {
            callId: requested.callId,
            state: VOICE_STATE.SUBMITTED,
            placementUncertain: true,
            message: 'The provider may or may not have placed this call. '
              + 'It stays submitted until a webhook settles it; do not retry blind.',
          },
        };
      }
      withStore(tenant.id, (store) => markFailed(store, requested.callId, { errorCode: 'PLACEMENT_FAILED' }));
      throw err;
    }
  }

  if (request.action === 'reconcile') {
    const { apiKey } = requireSecrets();
    const open = withStore(tenant.id, (store) => listVoiceCallsByState(store, [
      VOICE_STATE.SUBMITTED, VOICE_STATE.RINGING, VOICE_STATE.IN_PROGRESS,
    ]));

    const settled = [];
    const stillOpen = [];
    for (const call of open) {
      if (!call.providerCallId) {
        stillOpen.push({ callId: call.callId, reason: 'never reached the provider' });
        continue;
      }
      let remote;
      try {
        remote = await getCall({ apiKey, providerCallId: call.providerCallId });
      } catch (err) {
        stillOpen.push({ callId: call.callId, reason: String(err?.message || err).slice(0, 120) });
        continue;
      }
      const state = callStatusToState(remote.status);
      if (!state) {
        stillOpen.push({ callId: call.callId, reason: `provider reports ${remote.status || 'nothing'}` });
        continue;
      }
      const outcome = withStore(tenant.id, (store) => recordProviderEvent(store, {
        callId: call.callId,
        fingerprint: `reconcile:${call.providerCallId}:${remote.status}`,
        eventState: state,
        providerCallId: remote.providerCallId,
        answeredBy: remote.answeredBy,
        endedBy: remote.endedBy,
        errorCode: remote.errorMessage,
        providerAt: remote.endedAt,
        completedAt: remote.endedAt,
        summary: remote.summary,
        transcript: remote.transcript,
        payload: { reconciled: true, status: remote.status, providerCallId: remote.providerCallId },
      }));
      settled.push({ callId: call.callId, state: outcome?.state ?? state, duplicate: Boolean(outcome?.duplicate) });
    }

    return {
      tenantId: tenant.id,
      mutating: settled.length > 0,
      auditResult: { settled: settled.length, stillOpen: stillOpen.length },
      result: { checked: open.length, settled, stillOpen },
    };
  }

  if (request.action === 'stop') {
    const { apiKey } = requireSecrets();
    const callId = Number(params.call);
    if (!Number.isInteger(callId)) throw new Error('A numeric --call id is required');
    const providerCallId = withStore(tenant.id, (store) => {
      const call = voiceCallById(store, callId);
      if (!call) throw new Error(`No call ${callId} for this tenant`);
      return call.providerCallId;
    });
    if (!providerCallId) throw new Error('That call has no provider id yet');
    await stopCall({ apiKey, providerCallId });
    return {
      tenantId: tenant.id,
      mutating: true,
      auditParams: { callId },
      result: { callId, stopRequested: true },
    };
  }

  throw new Error(`Unsupported voice action: ${request.action || '<empty>'}`);
}
