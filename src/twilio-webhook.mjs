import { twilioAdapter } from './channels/twilio.mjs';
import {
  inboundPathFor,
  statusPathFor,
  signedWebhookUrl as signedUrl,
  handleInboundWebhook,
  handleStatusWebhook,
} from './channels/index.mjs';

export const TWILIO_INBOUND_PATH =
  process.env.ROCKY_TWILIO_INBOUND_PATH || inboundPathFor(twilioAdapter.id);
export const TWILIO_STATUS_PATH =
  process.env.ROCKY_TWILIO_STATUS_PATH || statusPathFor(twilioAdapter.id);

export const signedWebhookUrl = signedUrl;

export function parseFormBody(rawBody) {
  const params = {};
  for (const [key, value] of new URLSearchParams(String(rawBody || ''))) params[key] = value;
  return params;
}

export async function handleTwilioInbound({ rawBody, signature, url, channel, authToken }) {
  return handleInboundWebhook({
    adapter: authToken
      ? { ...twilioAdapter, verifyInbound: (a) => twilioAdapter.verifyInbound({ ...a, secret: authToken }) }
      : twilioAdapter,
    rawBody,
    headers: { 'x-twilio-signature': signature },
    url,
    channel,
  });
}

export async function handleTwilioStatus({ rawBody, signature, url, authToken, tenantId, openStore }) {
  return handleStatusWebhook({
    adapter: {
      ...twilioAdapter,
      ...(authToken
        ? { verifyInbound: (a) => twilioAdapter.verifyInbound({ ...a, secret: authToken }) }
        : {}),
      tenantFromStatusQuery: () => tenantId || null,
    },
    rawBody,
    headers: { 'x-twilio-signature': signature },
    url,
    searchParams: null,
    openStore,
  });
}
