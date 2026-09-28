import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCall, getCall, stopCall } from './client.mjs';

describe('Bland provider prototype', () => {
  it('creates a call with Rocky correlation and the Rocky webhook', async () => {
    let request;
    const result = await createCall({
      apiKey: 'synthetic-org-key',
      phoneNumber: '+919999999999',
      task: 'Confirm tomorrow morning is convenient.',
      webhookUrl: 'https://rocky.example/webhooks/bland/signed-reference',
      requestId: 'call-request-1',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ call_id: 'provider-call-1', status: 'queued' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    assert.equal(request.url, 'https://api.bland.ai/v1/calls');
    assert.equal(request.options.headers.authorization, 'synthetic-org-key');
    assert.deepEqual(JSON.parse(request.options.body), {
      phone_number: '+919999999999',
      task: 'Confirm tomorrow morning is convenient.',
      max_duration: 15,
      record: false,
      webhook: 'https://rocky.example/webhooks/bland/signed-reference',
      webhook_events: ['call'],
      metadata: { rocky_request_id: 'call-request-1' },
    });
    assert.deepEqual(result, { callId: 'provider-call-1', status: 'queued' });
  });

  it('normalizes call details without returning the provider envelope', async () => {
    const result = await getCall({
      apiKey: 'synthetic-org-key',
      callId: 'provider-call-1',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.bland.ai/v1/calls/provider-call-1');
        assert.equal(options.method, 'GET');
        return new Response(JSON.stringify({
          call_id: 'provider-call-1',
          completed: true,
          status: 'completed',
          summary: 'The appointment was confirmed.',
          concatenated_transcript: 'assistant: Hello\nuser: Confirmed',
          transcripts: [{ id: 1, user: 'user', text: 'Confirmed' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(result.callId, 'provider-call-1');
    assert.equal(result.status, 'completed');
    assert.equal(result.turns[0].speaker, 'user');
    assert.equal(result.transcript, 'assistant: Hello\nuser: Confirmed');
  });

  it('uses the documented stop endpoint', async () => {
    const result = await stopCall({
      apiKey: 'synthetic-org-key',
      callId: 'provider-call-1',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.bland.ai/v1/calls/provider-call-1/stop');
        assert.equal(options.method, 'POST');
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.deepEqual(result, { callId: 'provider-call-1', status: 'stop_requested' });
  });

  it('rejects unsafe call inputs before contacting Bland', async () => {
    await assert.rejects(
      createCall({
        apiKey: 'synthetic-org-key',
        phoneNumber: '9999999999',
        task: 'hello',
        webhookUrl: 'https://rocky.example/webhooks/bland/ref',
        requestId: 'request-1',
      }),
      /E\.164/,
    );
  });
});
