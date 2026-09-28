import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readParsedBody, readBodyBytes } from '../src/http-body.mjs';

function request(body, contentType = 'application/json') {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = contentType ? { 'content-type': contentType } : {};
  return stream;
}

describe('the gateway reads a JSON body', () => {
  it('returns a parsed object, so a caller must never parse it again', async () => {
    const out = await readParsedBody(request('{"jobId":"j1","summary":"hi"}'));
    assert.deepEqual(out, { jobId: 'j1', summary: 'hi' },
      'the cron ingress called JSON.parse on this result for months; parsing an '
      + 'object stringifies it to "[object Object]" and every delivery 400d');
    assert.equal(typeof out, 'object');
    assert.throws(() => JSON.parse(out), 'double-parsing is what broke cron delivery');
  });

  it('throws on malformed JSON so the route can answer 400', async () => {
    await assert.rejects(() => readParsedBody(request('{not json')));
  });

  it('treats an empty body as an empty object, not a parse failure', async () => {
    assert.deepEqual(await readParsedBody(request('')), {});
  });

  it('hands back non-JSON content unparsed', async () => {
    assert.deepEqual(
      await readParsedBody(request('a=1&b=2', 'application/x-www-form-urlencoded')),
      { raw: 'a=1&b=2' },
    );
  });
});

describe('a signed webhook needs the exact bytes', () => {
  it('returns a Buffer, not a string, so a signature is computed over what arrived', async () => {
    const out = await readBodyBytes(request('{"a":1}'));
    assert.ok(Buffer.isBuffer(out),
      'index.mjs already has a readRawBody returning a string; two readers with the same name '
      + 'and different contracts is exactly what broke cron delivery');
    assert.equal(out.toString('utf8'), '{"a":1}');
  });
});
