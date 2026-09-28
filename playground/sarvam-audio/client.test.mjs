import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { synthesizeToFile, transcribeFile } from './client.mjs';

let dir;
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-sarvam-')); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('Sarvam audio prototype', () => {
  it('uploads a local voice note and returns only normalized STT fields', async () => {
    const file = path.join(dir, 'note.ogg');
    await fs.writeFile(file, Buffer.from('fake ogg bytes'));
    let request;
    const result = await transcribeFile({
      filePath: file,
      apiKey: 'synthetic-key',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({
          request_id: 'req-1',
          transcript: 'prepare the term sheet',
          language_code: 'en-IN',
          language_probability: 0.98,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(request.url, 'https://api.sarvam.ai/speech-to-text');
    assert.equal(request.options.headers['api-subscription-key'], 'synthetic-key');
    assert.ok(request.options.body instanceof FormData);
    assert.equal(result.transcript, 'prepare the term sheet');
    assert.equal(result.languageCode, 'en-IN');
  });

  it('writes streamed TTS bytes atomically to the requested path', async () => {
    const output = path.join(dir, 'outbox', 'reply.mp3');
    const result = await synthesizeToFile({
      text: 'Your report is ready.',
      outputPath: output,
      apiKey: 'synthetic-key',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.sarvam.ai/text-to-speech/stream');
        assert.equal(JSON.parse(options.body).output_audio_codec, 'mp3');
        return new Response(Buffer.from('fake mp3 bytes'), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      },
    });

    assert.equal(result.bytes, 14);
    assert.equal((await fs.readFile(output)).toString(), 'fake mp3 bytes');
    assert.deepEqual((await fs.readdir(path.dirname(output))).sort(), ['reply.mp3']);
  });

  it('does not write a file when the provider rejects TTS', async () => {
    const output = path.join(dir, 'outbox', 'failed.mp3');
    await assert.rejects(
      synthesizeToFile({
        text: 'hello',
        outputPath: output,
        apiKey: 'synthetic-key',
        fetchImpl: async () => new Response(
          JSON.stringify({ error: { message: 'quota exceeded' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
      }),
      /Sarvam request failed \(429\)/,
    );
    await assert.rejects(fs.stat(output), /ENOENT/);
  });
});
