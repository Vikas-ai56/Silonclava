import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSignature, verifySignature, toWhatsAppAddress,
  normalizeInbound, normalizeStatusCallback, TwilioChannel,
} from '../src/twilio-channel.mjs';

const URL_ = 'https://irock.buglerockadvisors.com/webhook/whatsapp';
const TOKEN = 'test-auth-token-not-real';

describe('Twilio webhook signature (§6)', () => {
  it('matches Twilio’s documented algorithm on their worked example', () => {
    // The worked example published at https://www.twilio.com/docs/usage/security
    // — full URL including query string, POST params sorted case-sensitively by
    // key and appended as key+value with no delimiter, HMAC-SHA1 keyed by the
    // auth token, base64. Verified against the documented expected value rather
    // than against our own output, so this test can actually fail.
    const sig = computeSignature(
      'https://example.com/myapp.php?foo=1&bar=2',
      { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' },
      '12345',
    );
    assert.equal(sig, 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });

  it('accepts a correct signature and rejects a tampered body', () => {
    const params = { From: 'whatsapp:+6591234567', Body: 'hello', MessageSid: 'SM1' };
    const good = computeSignature(URL_, params, TOKEN);
    assert.equal(verifySignature({ url: URL_, params, signature: good, authToken: TOKEN }), true);

    // One changed character in the body must invalidate it.
    assert.equal(
      verifySignature({ url: URL_, params: { ...params, Body: 'hellp' }, signature: good, authToken: TOKEN }),
      false,
    );
  });

  it('rejects a signature computed for a different URL', () => {
    // This is why validation uses the configured public URL and never one
    // rebuilt from request headers: behind Caddy the proto/host differ, and
    // headers are attacker-influenced.
    const params = { Body: 'hi' };
    const sig = computeSignature('https://evil.example/webhook', params, TOKEN);
    assert.equal(verifySignature({ url: URL_, params, signature: sig, authToken: TOKEN }), false);
  });

  it('denies when unsigned, empty, or no token is configured', () => {
    const params = { Body: 'hi' };
    const sig = computeSignature(URL_, params, TOKEN);
    assert.equal(verifySignature({ url: URL_, params, signature: '', authToken: TOKEN }), false);
    assert.equal(verifySignature({ url: URL_, params, signature: sig, authToken: '' }), false);
    assert.equal(verifySignature({ url: URL_, params, signature: 'x', authToken: TOKEN }), false);
  });

  it('is order-independent over params but not over values', () => {
    const a = computeSignature(URL_, { B: '2', A: '1' }, TOKEN);
    const b = computeSignature(URL_, { A: '1', B: '2' }, TOKEN);
    assert.equal(a, b);
    assert.notEqual(a, computeSignature(URL_, { A: '2', B: '1' }, TOKEN));
  });
});

describe('Twilio normalization', () => {
  it('carries MessageSid through as the dedupe key', () => {
    const msg = normalizeInbound({ From: 'whatsapp:+6591234567', Body: 'hi', MessageSid: 'SM123' });
    assert.equal(msg.externalMessageId, 'SM123');
    assert.equal(msg.from, '+6591234567');
    assert.equal(msg.channel, 'whatsapp');
  });

  it('normalizes addresses from either form', () => {
    assert.equal(toWhatsAppAddress('+6591234567'), 'whatsapp:+6591234567');
    assert.equal(toWhatsAppAddress('whatsapp:+6591234567'), 'whatsapp:+6591234567');
    assert.equal(toWhatsAppAddress('6591234567@s.whatsapp.net'), 'whatsapp:+6591234567');
    assert.equal(toWhatsAppAddress(''), '');
  });

  it('maps a status callback to the delivery ledger shape', () => {
    const s = normalizeStatusCallback({ MessageSid: 'SM1', MessageStatus: 'DELIVERED' });
    assert.deepEqual(s, { providerMessageId: 'SM1', status: 'delivered', errorCode: null, detail: null });
    const f = normalizeStatusCallback({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: '63016' });
    assert.equal(f.errorCode, '63016');
  });
});

describe('Twilio send receipt (§6)', () => {
  it('returns provider SID and accepted time, and never puts the token in the body', async () => {
    let captured = null;
    const ch = new TwilioChannel({
      fetch: async (url, init) => {
        captured = { url, init };
        return { ok: true, json: async () => ({ sid: 'SM_SENT', status: 'queued', date_created: 'Thu, 18 Sep 2026 09:00:00 +0000' }) };
      },
    });
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.TWILIO_WHATSAPP_FROM = '+6580000000';
    try {
      const receipt = await ch.sendText('+6591234567', 'hello there');
      assert.equal(receipt.ok, true);
      assert.equal(receipt.providerMessageId, 'SM_SENT');
      assert.equal(receipt.status, 'queued');
      assert.ok(Date.parse(receipt.acceptedAt) > 0);

      assert.match(captured.url, /Accounts\/AC_test\/Messages\.json$/);
      assert.equal(captured.init.body.get('To'), 'whatsapp:+6591234567');
      // The secret travels in the Authorization header only, never the payload.
      assert.doesNotMatch(String(captured.init.body), new RegExp(TOKEN));
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_WHATSAPP_FROM;
    }
  });

  it('reports a provider rejection as a failed receipt rather than throwing', async () => {
    const ch = new TwilioChannel({
      fetch: async () => ({ ok: false, status: 400, json: async () => ({ code: 63016, message: 'outside window' }) }),
    });
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.TWILIO_WHATSAPP_FROM = '+6580000000';
    try {
      const receipt = await ch.sendText('+6591234567', 'hi');
      assert.equal(receipt.ok, false);
      assert.equal(receipt.errorCode, '63016');
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_WHATSAPP_FROM;
    }
  });
});
