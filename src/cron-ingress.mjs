import crypto from 'node:crypto';
import { openTenantStore } from './tenant-data/store.mjs';
import { saveCronResponse, beginSend, recordSendResult, markDeliveryUnknown }
  from './tenant-data/delivery-store.mjs';
import { loadTenant } from './tenants.mjs';
import { completeCronWake } from './wake-scheduler.mjs';

export function cronWebhookToken() {
  return String(process.env.ROCKY_CRON_WEBHOOK_TOKEN || '').trim();
}

/** Constant-time bearer check; an empty configured token denies everything. */
export function verifyCronToken(header) {
  const expected = cronWebhookToken();
  if (!expected) return false;
  const provided = String(header || '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} payload  the container's cron delivery body
 * @param {object} channel  the real outbound channel
 * @returns {Promise<{ok: boolean, status: number, body: object}>}
 */
export function cronRunIdentity(payload) {
  const jobId = String(payload?.jobId || '').trim();
  const runId = String(payload?.runId || '').trim();
  if (runId) return jobId ? `${jobId}:${runId}` : runId;
  const runAtMs = Number(payload?.runAtMs);
  if (jobId && Number.isFinite(runAtMs)) return `${jobId}:${runAtMs}`;
  return '';
}

export function cronResultText(payload) {
  return String(payload?.summary ?? payload?.text ?? '').trim();
}

export async function handleCronDelivery(payload, channel, tenantId) {
  const resolved = String(tenantId || '').trim();
  const text = cronResultText(payload);
  const runId = cronRunIdentity(payload);

  if (!resolved) {
    return { ok: false, status: 400, body: { error: 'tenant is not identified by this endpoint' } };
  }
  if (!runId) {
    return { ok: false, status: 400, body: { error: 'payload identifies no cron run' } };
  }
  if (!text) {
    return { ok: true, status: 204, body: { delivered: false, reason: 'empty' } };
  }


  const tenant = await loadTenant(resolved);
  if (!tenant) return { ok: false, status: 404, body: { error: 'unknown tenant' } };

  const recipient = tenant.jid || tenant.phone;
  if (!recipient) return { ok: false, status: 409, body: { error: 'tenant has no delivery address' } };

  const store = openTenantStore(resolved);
  try {
    const saved = saveCronResponse(store, {
      conversationId: resolved,
      recipient,
      text,
      runId,
    });
    if (saved.duplicate) {
      return { ok: true, status: 200, body: { delivered: false, reason: 'duplicate', turnId: saved.turnId } };
    }

    const attempt = beginSend(store, saved.turnId, saved.messageId);
    if (attempt === null) {
      console.warn(`[cron] ${resolved}: turn ${saved.turnId} was already claimed for sending — not sending twice`);
      return { ok: true, status: 200, body: { delivered: false, reason: 'send-already-started', turnId: saved.turnId } };
    }
    try {
      const receipt = await channel.sendText(recipient, text, { tenantId: resolved });
      recordSendResult(store, saved.turnId, saved.messageId, attempt, {
        ok: receipt?.ok !== false,
        providerMessageId: receipt?.providerMessageId ?? null,
        status: receipt?.status,
        errorCode: receipt?.errorCode,
        acceptedAt: receipt?.acceptedAt,
      });
      await completeCronWake(resolved).catch((err) =>
        console.warn(`[cron] wake bookkeeping failed for ${resolved}:`, err?.message || err),
      );
      return { ok: true, status: 200, body: { delivered: true, turnId: saved.turnId } };
    } catch (err) {
      markDeliveryUnknown(store, saved.turnId, saved.messageId, attempt, err?.code || 'SEND_ERROR');
      return { ok: false, status: 502, body: { error: 'delivery_unknown', turnId: saved.turnId } };
    }
  } finally {
    store.db.close();
  }
}
