import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { normalizeWebhook, verifyWebhookSignature, webhookFingerprint } from './webhook.mjs';

describe('Bland webhook prototype', () => {
  it('verifies the current X-Webhook-Signature HMAC contract', () => {
    const rawBody = Buffer.from('{"call_id":"call-1","status":"completed"}');
    const signature = crypto.createHmac('sha256', 'webhook-secret').update(rawBody).digest('hex');

    assert.equal(verifyWebhookSignature({ rawBody, signature, secret: 'webhook-secret' }), true);
    assert.equal(verifyWebhookSignature({ rawBody, signature, secret: 'wrong-secret' }), false);
  });

  it('requires verification against the unchanged bytes', () => {
    const original = '{"call_id":"call-1","status":"completed"}';
    const reparsed = '{"call_id": "call-1", "status": "completed"}';
    const signature = crypto.createHmac('sha256', 'webhook-secret').update(original).digest('hex');

    assert.equal(verifyWebhookSignature({ rawBody: reparsed, signature, secret: 'webhook-secret' }), false);
  });

  it('normalizes the lifecycle fields and ignores metadata as tenant authority', () => {
    const rawBody = JSON.stringify({
      call_id: 'call-1',
      completed: true,
      status: 'completed',
      answered_by: 'human',
      summary: 'Confirmed.',
      concatenated_transcript: 'user: Confirmed.',
      recording_url: 'https://provider.example/temporary-recording',
      metadata: { tenant_id: 'untrusted-other-tenant' },
      end_at: '2026-09-25T10:00:00Z',
    });
    const event = normalizeWebhook(rawBody);

    assert.equal(event.callId, 'call-1');
    assert.equal(event.status, 'completed');
    assert.equal(event.transcript, 'user: Confirmed.');
    assert.equal('tenantId' in event, false);
    assert.equal(event.fingerprint, webhookFingerprint(rawBody));
  });

  it('rejects malformed callbacks before persistence', () => {
    assert.throws(() => normalizeWebhook('{bad json'), /not valid JSON/);
    assert.throws(() => normalizeWebhook('{}'), /call_id is required/);
  });
});
