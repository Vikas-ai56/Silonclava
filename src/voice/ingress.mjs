import { blandSignatureRequired, blandWebhookSecret } from '../config.mjs';
import {
  parseWebhookEvent, rawBodyBytes, verifyWebhookSignature, webhookFingerprint,
} from './webhook.mjs';
import { recordProviderEvent, voiceCallByCallbackRef } from '../tenant-data/voice-store.mjs';
import { openTenantStore } from '../tenant-data/store.mjs';
import { listTenants } from '../tenants.mjs';

let warnedUnsigned = false;

export function blandWebhookConfigured() {
  return Boolean(blandWebhookSecret());
}

async function locateCall(callbackRef) {
  for (const tenant of await listTenants()) {
    let store;
    try {
      store = openTenantStore(tenant.id);
    } catch {
      continue;
    }
    try {
      const call = voiceCallByCallbackRef(store, callbackRef);
      if (call) return { tenantId: tenant.id, callId: call.callId };
    } finally {
      try {
        store.db.close();
      } catch {
        /* already closed */
      }
    }
  }
  return null;
}

export async function handleBlandWebhook({ callbackRef, rawBody, headers }) {
  const secret = blandWebhookSecret();
  const signatureRequired = blandSignatureRequired();
  if (!secret && signatureRequired) {
    return { ok: false, status: 503, body: { error: 'voice webhooks are not configured' } };
  }

  const ref = String(callbackRef || '').trim();
  if (!ref) return { ok: false, status: 400, body: { error: 'no callback reference' } };

  if (secret) {
    const verified = verifyWebhookSignature({ rawBody, headers, secret });
    if (!verified.ok) {
      return { ok: false, status: 401, body: { error: 'bad signature', reason: verified.reason } };
    }
  } else if (!warnedUnsigned) {
    warnedUnsigned = true;
    console.warn(
      '[voice] BLAND_WEBHOOK_REQUIRE_SIGNATURE=false and no BLAND_WEBHOOK_SECRET: '
      + 'callbacks are authenticated only by the unguessable callback reference in the url. '
      + 'Set a webhook secret in the Bland dashboard to restore signature verification.',
    );
  }

  let event;
  let payload;
  try {
    event = parseWebhookEvent(rawBody);
    payload = JSON.parse(rawBodyBytes(rawBody).toString('utf8'));
  } catch {
    return { ok: false, status: 400, body: { error: 'unreadable payload' } };
  }

  const located = await locateCall(ref);
  if (!located) return { ok: false, status: 404, body: { error: 'unknown call' } };

  const store = openTenantStore(located.tenantId);
  try {
    const outcome = recordProviderEvent(store, {
      callId: located.callId,
      fingerprint: event.fingerprint || webhookFingerprint(rawBodyBytes(rawBody)),
      eventState: event.eventState,
      providerCallId: event.providerCallId,
      answeredBy: event.answeredBy,
      endedBy: event.endedBy,
      errorCode: event.errorCode,
      providerAt: event.providerAt ?? null,
      completedAt: event.completedAt ?? null,
      summary: event.summary,
      transcript: event.transcript ?? null,
      payload,
    });
    if (outcome?.matched === false) {
      return { ok: false, status: 404, body: { error: 'callback matched no call', recorded: false } };
    }
    return {
      ok: true,
      status: 200,
      body: {
        recorded: true,
        duplicate: Boolean(outcome?.duplicate),
        state: outcome?.state ?? null,
      },
    };
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}
