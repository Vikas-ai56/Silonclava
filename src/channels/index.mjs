import { PUBLIC_BASE_URL } from '../config.mjs';
import { assertAdapter, describeCapabilities } from './port.mjs';
import { twilioAdapter } from './twilio.mjs';

const ADAPTERS = new Map([[twilioAdapter.id, assertAdapter(twilioAdapter)]]);

export function registerAdapter(adapter) {
  ADAPTERS.set(assertAdapter(adapter).id, adapter);
  return adapter;
}

export function knownProviders() {
  return [...ADAPTERS.keys()];
}

export function getAdapter(id) {
  return ADAPTERS.get(String(id || '').toLowerCase()) || null;
}

export function providerCapabilities(id) {
  const adapter = getAdapter(id);
  return adapter ? describeCapabilities(adapter) : null;
}

function envPath(generic, providerId, suffix) {
  const perProvider = `ROCKY_${providerId.toUpperCase()}_${suffix}_PATH`;
  return process.env[generic] || process.env[perProvider] || null;
}

export function inboundPathFor(id) {
  return envPath('ROCKY_WEBHOOK_INBOUND_PATH', id, 'INBOUND') || `/webhooks/${id}/inbound`;
}

export function statusPathFor(id) {
  return envPath('ROCKY_WEBHOOK_STATUS_PATH', id, 'STATUS') || `/webhooks/${id}/status`;
}

export function signedWebhookUrl(pathAndQuery) {
  const base = String(PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${pathAndQuery}`;
}

function unauthorized(reason) {
  return { ok: false, status: 403, body: { error: 'invalid signature', reason } };
}

export async function handleInboundWebhook({ adapter, rawBody, headers, url, channel }) {
  if (!url) {
    return { ok: false, status: 500, body: { error: 'ROCKY_PUBLIC_BASE_URL is not configured' } };
  }
  if (!adapter.verifyInbound({ rawBody, headers, url })) {
    return unauthorized('signature mismatch');
  }

  const msg = adapter.parseInbound(rawBody, headers);
  if (!msg?.from) {
    return { ok: false, status: 400, body: { error: 'sender is required' } };
  }
  if (typeof channel?.onMessage !== 'function') {
    return { ok: false, status: 503, body: { error: 'channel not ready' } };
  }

  await channel.onMessage(msg);
  return { ok: true, status: 204, body: null };
}

export async function handleStatusWebhook({
  adapter,
  rawBody,
  headers,
  url,
  searchParams,
  openStore,
  onTurnSettled,
}) {
  if (!url) {
    return { ok: false, status: 500, body: { error: 'ROCKY_PUBLIC_BASE_URL is not configured' } };
  }
  if (!adapter.verifyInbound({ rawBody, headers, url })) {
    return unauthorized('signature mismatch');
  }

  const update = adapter.parseStatus(rawBody, headers);
  if (!update?.providerMessageId || !update.status) {
    return { ok: true, status: 204, body: null };
  }

  const tenantId = adapter.tenantFromStatusQuery?.(searchParams) || null;
  if (!tenantId) {
    return { ok: true, status: 204, body: { applied: false, reason: 'no tenant scope' } };
  }

  let store;
  try {
    store = openStore(tenantId);
  } catch {
    return { ok: true, status: 204, body: { applied: false, reason: 'unknown tenant' } };
  }
  let settled = false;
  try {
    const { applyProviderStatus } = await import('../tenant-data/delivery-store.mjs');
    settled = Boolean(applyProviderStatus(store, update)?.settled);
  } catch (err) {
    return {
      ok: true,
      status: 204,
      body: { applied: false, reason: String(err?.message || err).slice(0, 120) },
    };
  } finally {
    store.db.close();
  }

  // This callback is the only thing that knows the turn just stopped
  // executing. Waking is injected rather than imported so the transport layer
  // keeps no dependency on the scheduler.
  if (settled && typeof onTurnSettled === 'function') {
    try {
      onTurnSettled(tenantId);
    } catch (err) {
      console.warn(`[delivery] ${tenantId}: lane wake after settle failed:`, err?.message || err);
    }
  }
  return { ok: true, status: 204, body: null };
}

export async function handleVerificationChallenge({ adapter, searchParams }) {
  const challenge = adapter.verificationChallenge?.(searchParams);
  if (challenge == null) return null;
  return { ok: true, status: 200, body: challenge, raw: true };
}
