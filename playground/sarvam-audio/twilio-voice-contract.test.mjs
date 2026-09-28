import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeInbound } from '../../src/twilio-channel.mjs';
import { mediaKind } from '../../src/inbound-media.mjs';
import { forwardingMetadata } from './twilio-voice-contract.mjs';

function payload(overrides = {}) {
  return {
    From: 'whatsapp:+919999999999',
    To: 'whatsapp:+10000000000',
    MessageSid: `SM${'1'.repeat(32)}`,
    Body: '',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.test/voice-note',
    MediaContentType0: 'audio/ogg',
    ...overrides,
  };
}

describe('Twilio voice-note contract', () => {
  it('routes a voice note recorded by the sender through the audio path', () => {
    const raw = payload();
    const message = normalizeInbound(raw);

    assert.equal(message.media.length, 1);
    assert.equal(message.media[0].contentType, 'audio/ogg');
    assert.equal(mediaKind(message.media[0].contentType), 'audio');
    assert.deepEqual(forwardingMetadata(raw), {
      forwarded: false,
      frequentlyForwarded: false,
    });
  });

  it('routes a forwarded voice note through the same audio path and preserves provenance', () => {
    const raw = payload({ Forwarded: 'true' });
    const message = normalizeInbound(raw);

    assert.equal(message.media.length, 1);
    assert.equal(message.media[0].contentType, 'audio/ogg');
    assert.equal(mediaKind(message.media[0].contentType), 'audio');
    assert.deepEqual(forwardingMetadata(raw), {
      forwarded: true,
      frequentlyForwarded: false,
    });
  });

  it('treats FrequentlyForwarded as forwarded even if Forwarded is absent', () => {
    assert.deepEqual(forwardingMetadata(payload({ FrequentlyForwarded: 'true' })), {
      forwarded: true,
      frequentlyForwarded: true,
    });
  });
});
