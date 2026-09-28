import {
  twilioConfigured,
  verifySignature,
  normalizeInbound,
  normalizeStatusCallback,
  TwilioChannel,
} from '../twilio-channel.mjs';

export const twilioAdapter = {
  id: 'twilio',

  capabilities: {
    maxBodyChars: 1600,
    // WhatsApp's accepted set. text/plain is NOT deliverable, so a .md or .txt
    // send is accepted by the API and silently dropped before the user sees it.
    // https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages
    mediaTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg', 'image/png', 'image/webp',
      'audio/ogg', 'audio/amr', 'video/3gpp', 'audio/aac', 'audio/mpeg',
      'video/mp4',
      'text/vcard',
    ],
    quoteOutbound: false,
    mediaOutbound: true,
    mediaNeedsPublicUrl: true,
    mediaPerMessage: 1,
    mediaNeedsPublicUrl: true,
    mediaFilename: false,
    mediaCaption: false,
    inboundReplyContext: true,
    inboundReplyWindowDays: 7,
    typingIndicator: true,
    readReceipts: 'via-typing-indicator',
    verificationChallenge: false,
  },

  configured: () => twilioConfigured(),

  missingConfigMessage:
    'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM are required',

  createChannel: (options = {}) => new TwilioChannel(options),

  signatureHeader: 'x-twilio-signature',

  verifyInbound({ rawBody, headers, url, secret }) {
    return verifySignature({
      url,
      params: parseForm(rawBody),
      signature: headers?.['x-twilio-signature'],
      ...(secret ? { authToken: secret } : {}),
    });
  },

  parseInbound(rawBody) {
    return normalizeInbound(parseForm(rawBody));
  },

  parseStatus(rawBody) {
    return normalizeStatusCallback(parseForm(rawBody));
  },

  tenantFromStatusQuery(searchParams) {
    return searchParams?.get('t') || null;
  },

  verificationChallenge() {
    return null;
  },

  async mediaAuth() {
    const { mediaFetchAuth } = await import('../twilio-channel.mjs');
    return mediaFetchAuth();
  },
};

function parseForm(rawBody) {
  const params = {};
  for (const [key, value] of new URLSearchParams(String(rawBody || ''))) params[key] = value;
  return params;
}
