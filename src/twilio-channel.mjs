import crypto from 'node:crypto';

const API_ROOT = process.env.TWILIO_API_ROOT || 'https://api.twilio.com/2010-04-01';
// Typing indicators live on the v3 Messaging host, not the 2010-04-01 API.
const MESSAGING_V3_ROOT = process.env.TWILIO_MESSAGING_V3_ROOT || 'https://messaging.twilio.com/v3';

function creds() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const from = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_NUMBER || '';
  return { accountSid, authToken, from };
}

export function twilioConfigured() {
  const { accountSid, authToken, from } = creds();
  return Boolean(accountSid && authToken && from);
}

export function toWhatsAppAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('whatsapp:')) return raw;
  const digits = raw.replace(/@.*$/, '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  return `whatsapp:${digits.startsWith('+') ? digits : `+${digits}`}`;
}

export function computeSignature(url, params, authToken) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], String(url));
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifySignature({ url, params, signature, authToken = creds().authToken }) {
  if (!authToken || !signature) return false;
  const expected = computeSignature(url, params, authToken);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normalizeInbound(params) {
  const from = String(params.From || '');
  const digits = from.replace(/^whatsapp:/, '');
  return {
    channel: 'whatsapp',
    from: digits,
    chatJid: digits,
    phoneJid: digits,
    to: String(params.To || '').replace(/^whatsapp:/, ''),
    text: String(params.Body || ''),
    externalMessageId: String(params.MessageSid || params.SmsMessageSid || '') || null,
    numMedia: Number(params.NumMedia || 0),
    // Twilio numbers media params from zero and authenticates the URLs with
    // HTTP Basic using the account credentials. The URL is signed for about
    // four hours, so it is fetched on receipt and never stored.
    media: Array.from({ length: Number(params.NumMedia || 0) }, (_, i) => ({
      url: params[`MediaUrl${i}`],
      contentType: params[`MediaContentType${i}`] || '',
    })).filter((m) => m.url),
    replyToExternalId: String(params.OriginalRepliedMessageSid || '') || null,
    replyToSender: String(params.OriginalRepliedMessageSender || '').replace(/^whatsapp:/, '') || null,
    profileName: String(params.ProfileName || '') || null,
    at: new Date().toISOString(),
  };
}

/** Basic auth for fetching inbound media URLs — Twilio enforces it. */
export function mediaFetchAuth() {
  const { accountSid, authToken } = creds();
  if (!accountSid || !authToken) return null;
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

export function normalizeStatusCallback(params) {
  return {
    providerMessageId: String(params.MessageSid || params.SmsSid || '') || null,
    status: String(params.MessageStatus || params.SmsStatus || '').toLowerCase(),
    errorCode: params.ErrorCode ? String(params.ErrorCode) : null,
    detail: params.ErrorMessage ? String(params.ErrorMessage) : null,
  };
}

export class TwilioChannel {
  constructor(options = {}) {
    this.onMessage = null;
    this.statusCallbackUrl = options.statusCallbackUrl || process.env.TWILIO_STATUS_CALLBACK_URL || '';
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  async start() {
    if (!twilioConfigured()) {
      throw new Error('Twilio channel requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM');
    }
  }

  async setTyping(to, on = true, { messageId = null } = {}) {
    if (!on || !messageId) return { ok: false, skipped: true };
    const { accountSid, authToken } = creds();
    try {
      const res = await this.fetchImpl(`${MESSAGING_V3_ROOT}/Indicators/Typing.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: 'WHATSAPP', messageId }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, status: res.status, detail: detail.slice(0, 200) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 160) };
    }
  }

  async sendMedia(to, mediaUrl, { caption = '', tenantId = null } = {}) {
    if (caption.trim()) await this.sendText(to, caption, { tenantId });

    const { accountSid, authToken, from } = creds();
    const address = toWhatsAppAddress(to);
    if (!address) throw new Error('Twilio send requires a recipient address');

    const body = new URLSearchParams({
      To: address,
      From: toWhatsAppAddress(from),
      MediaUrl: String(mediaUrl),
    });
    if (this.statusCallbackUrl) {
      const cb = tenantId
        ? `${this.statusCallbackUrl}${this.statusCallbackUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(tenantId)}`
        : this.statusCallbackUrl;
      body.set('StatusCallback', cb);
    }

    const res = await this.fetchImpl(`${API_ROOT}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: json.sid || null,
        status: 'failed',
        errorCode: String(json.code || res.status),
      };
    }
    return {
      ok: true,
      providerMessageId: json.sid || null,
      status: String(json.status || 'queued').toLowerCase(),
    };
  }

  async sendText(to, text, options = {}) {
    const { accountSid, authToken, from } = creds();
    const address = toWhatsAppAddress(to);
    if (!address) throw new Error('Twilio send requires a recipient address');

    const body = new URLSearchParams({
      To: address,
      From: toWhatsAppAddress(from),
      Body: String(text ?? ''),
    });
    if (this.statusCallbackUrl) {
      const callback = options.tenantId
        ? `${this.statusCallbackUrl}${this.statusCallbackUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(options.tenantId)}`
        : this.statusCallbackUrl;
      body.set('StatusCallback', callback);
    }

    const res = await this.fetchImpl(`${API_ROOT}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        // Basic auth over TLS; the token never reaches argv or a log line.
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: json.sid || null,
        status: 'failed',
        // Twilio's numeric code is the useful part; the message may echo content.
        errorCode: String(json.code || res.status),
        acceptedAt: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      providerMessageId: json.sid || null,
      status: String(json.status || 'queued').toLowerCase(),
      acceptedAt: json.date_created ? new Date(json.date_created).toISOString() : new Date().toISOString(),
    };
  }
}
