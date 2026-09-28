import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcribeAudio as transcribeThroughSeam } from '../src/transcription.mjs';
import {
  SarvamError,
  SARVAM_AUTH_HEADER,
  MAX_TTS_CHARACTERS,
  hiddenTemporaryPathFor,
  isRetryableStatus,
  synthesizeSpeech,
  transcribeAudio,
} from '../src/speech/sarvam.mjs';

const SECRET = 'sk-sarvam-DO-NOT-LEAK-0123456789';

let root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-sarvam-speech-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let caseCounter = 0;
async function freshDir(tag) {
  caseCounter += 1;
  const dir = path.join(root, `${tag}-${caseCounter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function voiceNote(dir, name, bytes) {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(calls.length, url, options);
  };
  impl.calls = calls;
  return impl;
}

function refusingFetch() {
  return recordingFetch(() => {
    throw new Error('the provider must not be contacted for this input');
  });
}

function recordedSleeps() {
  const delays = [];
  const impl = async (ms) => { delays.push(ms); };
  impl.delays = delays;
  return impl;
}

const noRetries = { maxAttempts: 1, sleepImpl: async () => {} };

describe('Sarvam speech-to-text', () => {
  it('returns only the normalized transcript fields from a successful call', async () => {
    const dir = await freshDir('stt-success');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse({
      request_id: 'req-77',
      transcript: '  prepare the term sheet  ',
      language_code: 'en-IN',
      language_probability: 0.98,
    }));

    const result = await transcribeAudio({
      filePath: file,
      contentType: 'audio/ogg',
      apiKey: SECRET,
      fetchImpl,
      ...noRetries,
    });

    assert.equal(fetchImpl.calls[0].url, 'https://api.sarvam.ai/speech-to-text',
      'the client must post to the documented synchronous transcribe endpoint');
    assert.equal(fetchImpl.calls[0].options.headers[SARVAM_AUTH_HEADER], SECRET,
      'Sarvam authenticates on the api-subscription-key header, so the key must travel there');
    assert.equal(result.transcript, 'prepare the term sheet',
      'the transcript must reach the agent trimmed and unchanged in substance');
    assert.equal(result.languageCode, 'en-IN',
      'the detected language tells the agent which language the client actually spoke');
    assert.equal(result.requestId, 'req-77',
      'the provider request id is the only handle support has when a transcript is disputed');
    assert.deepEqual(Object.keys(result).sort(), ['languageCode', 'requestId', 'transcript'],
      'no raw provider envelope may escape the client');
  });

  it('uploads the content type the caller recorded, never one derived from the file name', async () => {
    const dir = await freshDir('stt-content-type');
    const file = await voiceNote(dir, 'note.wav', Buffer.from('actually opus'));
    const fetchImpl = recordingFetch(() => jsonResponse({ transcript: 'hello' }));

    await transcribeAudio({
      filePath: file,
      contentType: 'audio/ogg',
      apiKey: SECRET,
      fetchImpl,
      ...noRetries,
    });

    const form = fetchImpl.calls[0].options.body;
    assert.ok(form instanceof FormData, 'the transcribe endpoint takes multipart/form-data');
    const uploaded = form.get('file');
    assert.equal(uploaded.type, 'audio/ogg',
      'Twilio records the media content type; re-deriving it from a .wav name would mislabel an Opus note');
    assert.equal(uploaded.name, 'note.wav',
      'the stored file name is still what identifies the part');
  });

  it('refuses an oversize recording before it opens a connection', async () => {
    const dir = await freshDir('stt-oversize');
    const file = await voiceNote(dir, 'long.ogg', Buffer.alloc(4096, 1));
    const fetchImpl = refusingFetch();

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        maxInputBytes: 1024,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.retryable === false && /4096 bytes/.test(err.message),
      'an oversize upload is a terminal refusal, not something to retry',
    );
    assert.equal(fetchImpl.calls.length, 0,
      'the size ceiling exists to avoid the upload, so no request may be made');
  });

  it('treats an empty recording as an error rather than an empty transcript', async () => {
    const dir = await freshDir('stt-empty-file');
    const file = await voiceNote(dir, 'silent.ogg', Buffer.alloc(0));
    const fetchImpl = refusingFetch();

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && /empty/.test(err.message),
      'a zero-byte download is a failed fetch, not a silent voice note',
    );
    assert.equal(fetchImpl.calls.length, 0, 'an empty file must not be uploaded');
  });

  it('treats an empty transcript as a failure so no blank quote reaches the agent', async () => {
    const dir = await freshDir('stt-empty-transcript');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse({ request_id: 'req-9', transcript: '   ' }));

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.retryable === false && /empty transcript/.test(err.message),
      'an empty transcript must become the explicit untranscribed fallback, not an empty message',
    );
  });

  it('stops at a 403 without retrying, because a bad key never becomes good', async () => {
    const dir = await freshDir('stt-403');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse(
      { error: { message: 'invalid api key', code: 'authentication_error' } },
      403,
    ));
    const sleepImpl = recordedSleeps();

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        sleepImpl,
        maxAttempts: 5,
      }),
      (err) => err instanceof SarvamError && err.status === 403 && err.retryable === false,
      '403 is a configuration failure and must be reported as terminal',
    );
    assert.equal(fetchImpl.calls.length, 1,
      'retrying a rejected credential only burns quota and delays the fallback');
    assert.equal(sleepImpl.delays.length, 0, 'a terminal failure must not sleep');
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    const dir = await freshDir('stt-429');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch((call) => (call === 1
      ? jsonResponse({ error: { message: 'Quota Exceeded' } }, 429)
      : jsonResponse({ transcript: 'send the mandate', language_code: 'en-IN' })));
    const sleepImpl = recordedSleeps();

    const result = await transcribeAudio({
      filePath: file,
      contentType: 'audio/ogg',
      apiKey: SECRET,
      fetchImpl,
      sleepImpl,
      maxAttempts: 3,
      retryBaseMs: 40,
    });

    assert.equal(result.transcript, 'send the mandate',
      'a throttled first attempt must not cost the user their voice note');
    assert.equal(fetchImpl.calls.length, 2, 'exactly one retry was needed');
    assert.deepEqual(sleepImpl.delays, [40], 'the retry must back off before trying again');
  });

  it('gives up after the attempt bound and still reports the failure as retryable', async () => {
    const dir = await freshDir('stt-429-exhausted');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse({ error: { message: 'Quota Exceeded' } }, 429));
    const sleepImpl = recordedSleeps();

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        sleepImpl,
        maxAttempts: 3,
        retryBaseMs: 10,
        retryCeilingMs: 25,
      }),
      (err) => err instanceof SarvamError && err.retryable === true && err.attempts === 3,
      'the caller needs to know the failure was transient so a durable job can be requeued',
    );
    assert.equal(fetchImpl.calls.length, 3, 'retries must stop at the configured bound');
    assert.deepEqual(sleepImpl.delays, [10, 20], 'backoff grows and stays under the ceiling');
  });

  it('aborts a hanging request at the caller-configured timeout', async () => {
    const dir = await freshDir('stt-timeout');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch((call, url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        timeoutMs: 25,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.retryable === true && /timed out after 25ms/.test(err.message),
      'a provider that never answers must not hold a turn open forever',
    );
    assert.equal(fetchImpl.calls[0].options.signal.aborted, true,
      'the timeout must actually abort the in-flight request, not just reject locally');
  });
});

describe('Sarvam text-to-speech', () => {
  it('writes the streamed audio and reports what it wrote', async () => {
    const dir = await freshDir('tts-success');
    const fetchImpl = recordingFetch(() => new Response(Buffer.from('fake mp3 bytes'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }));

    const result = await synthesizeSpeech({
      text: 'Your report is ready.',
      outputPath: 'outbox/reply.mp3',
      baseDir: dir,
      apiKey: SECRET,
      fetchImpl,
      ...noRetries,
    });

    assert.equal(fetchImpl.calls[0].url, 'https://api.sarvam.ai/text-to-speech/stream',
      'the client must post to the documented streaming synthesis endpoint');
    const sent = JSON.parse(fetchImpl.calls[0].options.body);
    assert.equal(sent.output_audio_codec, 'mp3', 'the codec the caller asked for is the codec requested');
    assert.equal(sent.text, 'Your report is ready.', 'the spoken text must reach the provider unchanged');
    assert.equal(result.bytes, 14, 'the caller needs the real byte count to log a delivery');
    assert.equal(result.outputPath, path.join(dir, 'outbox', 'reply.mp3'),
      'the outbox needs the exact path the bytes landed at');
    assert.equal((await fs.readFile(result.outputPath)).toString(), 'fake mp3 bytes',
      'the file on disk must be the audio the provider streamed');
    assert.deepEqual(await fs.readdir(path.join(dir, 'outbox')), ['reply.mp3'],
      'a completed synthesis leaves exactly one file behind');
  });

  it('refuses an output path that escapes the caller-supplied base directory', async () => {
    const dir = await freshDir('tts-escape');
    const base = path.join(dir, 'tenant-a');
    await fs.mkdir(base, { recursive: true });
    const fetchImpl = refusingFetch();

    for (const escape of ['../tenant-b/reply.mp3', path.join(dir, 'tenant-b', 'reply.mp3'), '..']) {
      await assert.rejects(
        () => synthesizeSpeech({
          text: 'hello',
          outputPath: escape,
          baseDir: base,
          apiKey: SECRET,
          fetchImpl,
          ...noRetries,
        }),
        (err) => err instanceof SarvamError && /outside the permitted base directory/.test(err.message),
        `${escape} must not be writable from tenant A's synthesis call`,
      );
    }
    assert.equal(fetchImpl.calls.length, 0,
      'confinement is checked before the request, so a rejected path costs nothing');
    assert.deepEqual(await fs.readdir(dir), ['tenant-a'],
      'a rejected path must not even have its parent directory created outside the base');
    await assert.rejects(fs.stat(path.join(dir, 'tenant-b', 'reply.mp3')), /ENOENT/,
      'nothing may be created outside the base directory');
  });

  it('refuses an output path that reaches outside the base through a symlink', async () => {
    const dir = await freshDir('tts-symlink');
    const base = path.join(dir, 'tenant-a');
    const neighbour = path.join(dir, 'tenant-b');
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(neighbour, { recursive: true });
    await fs.symlink(neighbour, path.join(base, 'shared'), 'dir');
    const fetchImpl = refusingFetch();

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'shared/reply.mp3',
        baseDir: base,
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && /outside the permitted base directory/.test(err.message),
      'a symlink planted in tenant A must not become a write into tenant B',
    );
    assert.deepEqual(await fs.readdir(neighbour), [],
      'the neighbouring tenant workspace must be untouched');
    assert.equal(fetchImpl.calls.length, 0, 'the escape is refused before any provider call');
  });

  it('refuses text beyond the documented character limit before it opens a connection', async () => {
    const dir = await freshDir('tts-too-long');
    const fetchImpl = refusingFetch();

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'x'.repeat(MAX_TTS_CHARACTERS + 1),
        outputPath: 'reply.mp3',
        baseDir: dir,
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.retryable === false && /3500-character limit/.test(err.message),
      'the provider caps streaming synthesis at 3500 characters, so the caller must chunk instead',
    );
    assert.equal(fetchImpl.calls.length, 0, 'over-long text must not be sent and charged for');
  });

  it('leaves no file behind when the provider rejects the request', async () => {
    const dir = await freshDir('tts-provider-failure');
    const fetchImpl = recordingFetch(() => jsonResponse({ error: { message: 'Service Overloaded' } }, 503));

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'outbox/failed.mp3',
        baseDir: dir,
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.status === 503 && err.retryable === true,
      'a 503 is transient and must be reported as such',
    );
    assert.deepEqual(await fs.readdir(path.join(dir, 'outbox')), [],
      'a half-written reply in the outbox would be delivered as a broken voice note',
    );
  });

  it('leaves no partial file behind when the final store fails', async () => {
    const dir = await freshDir('tts-store-failure');
    const blocked = path.join(dir, 'outbox', 'reply.mp3');
    await fs.mkdir(blocked, { recursive: true });
    const fetchImpl = recordingFetch(() => new Response(Buffer.from('fake mp3 bytes'), { status: 200 }));

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'outbox/reply.mp3',
        baseDir: dir,
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.retryable === false,
      'a store that cannot complete is a terminal failure for this synthesis',
    );
    const left = await fs.readdir(path.join(dir, 'outbox'));
    assert.deepEqual(left, ['reply.mp3'],
      'the temp file must be removed; the outbox delivers whatever it finds');
  });

  it('names its temp file so the outbox scanner cannot pick it up mid-write', () => {
    const destination = path.join(root, 'tenant-a', 'workspace', 'outbox', 'reply.mp3');
    const temporary = hiddenTemporaryPathFor(destination);

    assert.equal(path.dirname(temporary), path.dirname(destination),
      'the temp file must share a directory with its destination or the rename stops being atomic');
    assert.ok(path.basename(temporary).startsWith('.'),
      'the outbox delivers every non-hidden file it finds, so a visible temp file would be sent half-written');
    assert.notEqual(temporary, hiddenTemporaryPathFor(destination),
      'two concurrent syntheses of the same reply must not share a temp file');
  });

  it('treats empty audio as a failure rather than writing a zero-byte reply', async () => {
    const dir = await freshDir('tts-empty-audio');
    const fetchImpl = recordingFetch(() => new Response(Buffer.alloc(0), { status: 200 }));

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'outbox/reply.mp3',
        baseDir: dir,
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && /empty audio/.test(err.message),
      'a zero-byte voice reply is worse than no voice reply',
    );
    assert.deepEqual(await fs.readdir(path.join(dir, 'outbox')), [],
      'nothing may be written when the provider returned no audio',
    );
  });

  it('refuses a codec the provider does not document', async () => {
    const dir = await freshDir('tts-bad-codec');
    const fetchImpl = refusingFetch();

    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'reply.ogg',
        baseDir: dir,
        apiKey: SECRET,
        codec: 'vorbis',
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && /vorbis/.test(err.message),
      'an undocumented codec would be a wasted call and an undeliverable file',
    );
    assert.equal(fetchImpl.calls.length, 0, 'an invalid codec must not reach the provider');
  });
});

describe('Sarvam client secrecy and classification', () => {
  it('never puts the API key into a thrown message, even when the provider echoes it', async () => {
    const dir = await freshDir('secrecy');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const echoing = recordingFetch(() => jsonResponse(
      { error: { message: `key ${SECRET} is not valid for this account` } },
      403,
    ));

    const thrown = [];
    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl: echoing,
        ...noRetries,
      }),
      (err) => { thrown.push(err); return true; },
    );
    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello',
        outputPath: 'reply.mp3',
        baseDir: dir,
        apiKey: SECRET,
        fetchImpl: recordingFetch(() => jsonResponse(
          { error: { message: `key ${SECRET} is not valid` } },
          403,
        )),
        ...noRetries,
      }),
      (err) => { thrown.push(err); return true; },
    );

    for (const err of thrown) {
      assert.ok(!err.message.includes(SECRET),
        'the firm key must never reach a log line, an alert or a model prompt');
      assert.ok(err.message.includes('[redacted]'),
        'the echoed secret must be replaced, not merely truncated away by luck');
      assert.ok(!String(err.stack).includes(SECRET),
        'the stack is logged as often as the message');
    }
  });

  it('classifies statuses the way the retry loop depends on', () => {
    assert.equal(isRetryableStatus(401), false, 'an unauthenticated key will not become authenticated');
    assert.equal(isRetryableStatus(403), false, 'a forbidden key is a configuration failure');
    assert.equal(isRetryableStatus(400), false, 'a malformed request repeats identically');
    assert.equal(isRetryableStatus(422), false, 'unprocessable audio stays unprocessable');
    assert.equal(isRetryableStatus(408), true, 'a request timeout is transient');
    assert.equal(isRetryableStatus(429), true, 'quota resets');
    assert.equal(isRetryableStatus(500), true, 'a provider fault is transient');
    assert.equal(isRetryableStatus(503), true, 'an overloaded provider recovers');
  });

  it('reports a 401 as terminal and does not retry it', async () => {
    const dir = await freshDir('unauthorized');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse({ error: { message: 'unauthorized' } }, 401));

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        maxAttempts: 4,
        sleepImpl: async () => {},
      }),
      (err) => err instanceof SarvamError && err.status === 401 && err.retryable === false,
      '401 is terminal for the same reason 403 is',
    );
    assert.equal(fetchImpl.calls.length, 1, 'a rejected credential is retried zero times');
  });

  it('truncates provider error detail instead of carrying an envelope', async () => {
    const dir = await freshDir('truncation');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));
    const fetchImpl = recordingFetch(() => jsonResponse(
      { error: { message: 'z'.repeat(5000), code: 'invalid_request_error', request_id: 'req-1' } },
      400,
    ));

    await assert.rejects(
      () => transcribeAudio({
        filePath: file,
        contentType: 'audio/ogg',
        apiKey: SECRET,
        fetchImpl,
        ...noRetries,
      }),
      (err) => err instanceof SarvamError && err.message.length < 400,
      'an unbounded provider message would flood the logs and could carry client words',
    );
  });
});

describe('the transcription seam', () => {
  const previousKey = process.env.SARVAM_API_KEY;
  after(() => {
    if (previousKey === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = previousKey;
  });

  it('returns null when no key is configured, because there is no local fallback', async () => {
    delete process.env.SARVAM_API_KEY;
    const dir = await freshDir('seam-unconfigured');
    const file = await voiceNote(dir, 'note.ogg', Buffer.from('opus bytes'));

    assert.equal(await transcribeThroughSeam('br_seam', { path: file, contentType: 'audio/ogg' }), null,
      'an unconfigured provider must record the voice note untranscribed, not crash the turn');
  });

  it('returns null when the caller supplies no recorded content type', async () => {
    process.env.SARVAM_API_KEY = SECRET;
    assert.equal(await transcribeThroughSeam('br_seam', 'note.ogg'), null,
      'the content type must come from the caller, so a bare file name cannot be transcribed');
    assert.equal(await transcribeThroughSeam('br_seam', { path: '/tmp/note.ogg' }), null,
      'a media record without a recorded content type is the same gap');
  });

  it('delegates to the provider client once a key and a full media record exist', async () => {
    process.env.SARVAM_API_KEY = SECRET;
    const dir = await freshDir('seam-delegates');

    await assert.rejects(
      () => transcribeThroughSeam('br_seam', {
        path: path.join(dir, 'never-downloaded.ogg'),
        contentType: 'audio/ogg',
      }),
      (err) => err instanceof SarvamError && err.operation === 'speech-to-text',
      'the seam must reach the Sarvam client so the router can classify the failure',
    );
  });
});

describe('codec and sample rate must be a pairing the provider accepts', () => {
  const never = async () => { throw new Error('the request must not reach the network'); };
  const call = (codec, sampleRate) => synthesizeSpeech({
    text: 'hello', outputPath: '/tmp/x.audio', baseDir: '/tmp', apiKey: 'k',
    codec, sampleRate, fetchImpl: never,
  });

  it('refuses a codec that needs a rate when none is given', async () => {
    await assert.rejects(() => call('opus', null), /requires an explicit sampleRate/,
      'the provider default is 22050, which opus rejects — failing at the provider wastes a call');
  });

  it('refuses a rate the codec does not support', async () => {
    await assert.rejects(() => call('opus', 22050), /does not support sampleRate 22050/);
    await assert.rejects(() => call('mulaw', 16000), /does not support sampleRate 16000/,
      'mulaw is 8000 only');
  });

  it('leaves mp3 alone, which carries no rate constraint', async () => {
    await assert.rejects(
      () => call('mp3', null),
      (err) => !/sampleRate/i.test(err.message),
      'mp3 must pass validation and reach the request, not be refused for a rate it does not need',
    );
  });
});

describe('the speaker must exist on the model being used', () => {
  it('refuses a speaker the model does not carry, before spending a request', async () => {
    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello', outputPath: '/tmp/x.mp3', baseDir: '/tmp', apiKey: 'k',
        speaker: 'anushka',
        fetchImpl: async () => { throw new Error('must not reach the network'); },
      }),
      /not available on bulbul:v3/,
      'anushka is a v2 voice; every spoken reply 400d at the provider because of it',
    );
  });

  it('accepts the default speaker', async () => {
    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello', outputPath: '/tmp/x.mp3', baseDir: '/tmp', apiKey: 'k',
        fetchImpl: async () => { throw new Error('reached the network'); },
      }),
      (err) => !/not available on/.test(err.message),
      'the shipped default must pass its own validation',
    );
  });
});

describe('the speaker guard is not disabled by overriding the model', () => {
  it('still refuses a v3-only speaker on v3 when the model was passed explicitly', async () => {
    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello', outputPath: '/tmp/x.mp3', baseDir: '/tmp', apiKey: 'k',
        model: 'bulbul:v3', speaker: 'anushka',
        fetchImpl: async () => { throw new Error('must not reach the network'); },
      }),
      /not available on bulbul:v3/,
      'gating the check on model === DEFAULT meant one env var turned off the guard that '
      + 'exists because this pairing broke production twice',
    );
  });

  it('does not block a model whose speaker list we do not know', async () => {
    await assert.rejects(
      () => synthesizeSpeech({
        text: 'hello', outputPath: '/tmp/x.mp3', baseDir: '/tmp', apiKey: 'k',
        model: 'bulbul:v4', speaker: 'someone-new',
        fetchImpl: async () => { throw new Error('reached the network'); },
      }),
      (err) => !/not available on/.test(err.message),
      'we cannot know a future model’s voices, so it must pass through rather than be refused',
    );
  });
});
