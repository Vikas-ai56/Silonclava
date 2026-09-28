import { chunkMessage } from '../message-chunks.mjs';

export const INBOUND_PATH = '/webhooks/:provider/inbound';
export const STATUS_PATH = '/webhooks/:provider/status';

export const REQUIRED_ADAPTER_METHODS = [
  'id',
  'capabilities',
  'configured',
  'createChannel',
  'verifyInbound',
  'parseInbound',
  'parseStatus',
];

export const DEFAULT_CAPABILITIES = {
  /** Provider body cap. null = unlimited. Enforced by the port, not the adapter. */
  maxBodyChars: null,
  /** Content types the provider will actually deliver. null = unrestricted. */
  mediaTypes: null,
  quoteOutbound: false,
  mediaOutbound: false,
  mediaPerMessage: 0,
  mediaNeedsPublicUrl: false,
  mediaFilename: false,
  mediaCaption: false,
  inboundReplyContext: false,
  inboundReplyWindowDays: null,
  verificationChallenge: false,
  typingIndicator: false,
  readReceipts: false,
};

export function describeCapabilities(adapter) {
  return { ...DEFAULT_CAPABILITIES, ...(adapter?.capabilities || {}) };
}

export function assertAdapter(adapter) {
  const missing = REQUIRED_ADAPTER_METHODS.filter((key) => adapter?.[key] === undefined);
  if (missing.length) {
    throw new Error(
      `Channel adapter "${adapter?.id || 'unknown'}" is missing: ${missing.join(', ')}`,
    );
  }
  return adapter;
}

export function normalizedInboundShape() {
  return {
    channel: 'whatsapp',
    from: '',
    chatJid: '',
    phoneJid: '',
    to: '',
    text: '',
    externalMessageId: null,
    numMedia: 0,
    media: [],
    replyToExternalId: null,
    replyToSender: null,
    profileName: null,
    at: '',
  };
}

export function normalizedStatusShape() {
  return {
    providerMessageId: null,
    status: '',
    errorCode: null,
    detail: null,
  };
}

/**
 * Every outbound text passes through here, whatever the provider. The limit is
 * the provider's, so it is declared as a capability; the enforcement is the
 * port's, so no adapter can forget it. Media is untouched.
 */
export function enforceBodyLimit(channel, capabilities) {
  const limit = Number(capabilities?.maxBodyChars || 0);
  if (!limit || typeof channel?.sendText !== 'function') return channel;

  const sendText = channel.sendText.bind(channel);
  channel.sendText = async (to, text, options = {}) => {
    const parts = chunkMessage(text, limit);
    if (parts.length <= 1) return sendText(to, parts[0] ?? '', options);
    let receipt = null;
    for (const part of parts) receipt = await sendText(to, part, options);
    return receipt;
  };
  return channel;
}

/** Expose the provider's capabilities on the channel itself, so delivery code
 *  can ask what this provider will accept without importing the adapter. */
export function withCapabilities(channel, capabilities) {
  if (channel && !channel.capabilities) channel.capabilities = capabilities;
  return channel;
}
