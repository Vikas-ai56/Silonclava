import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleBlandWebhook } from '../src/voice/ingress.mjs';

const SECRET = 'webhook-secret-for-tests';
let previous;
before(() => {
  previous = process.env.BLAND_WEBHOOK_SECRET;
  process.env.BLAND_WEBHOOK_SECRET = SECRET;
});
after(() => {
  if (previous === undefined) delete process.env.BLAND_WEBHOOK_SECRET;
  else process.env.BLAND_WEBHOOK_SECRET = previous;
});

const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const body = (obj) => Buffer.from(JSON.stringify(obj));

describe('the Bland webhook route', () => {
  it('refuses an unsigned callback', async () => {
    const raw = body({ call_id: 'c1', status: 'completed' });
    const out = await handleBlandWebhook({ callbackRef: 'ref', rawBody: raw, headers: {} });
    assert.equal(out.status, 401,
      'anyone can POST to a public url; the signature is the only thing that makes it Bland');
  });

  it('refuses a signature computed over a re-serialized body', async () => {
    const original = body({ call_id: 'c1', status: 'completed', n: 1 });
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString())) + ' ');
    const out = await handleBlandWebhook({
      callbackRef: 'ref',
      rawBody: original,
      headers: { 'x-webhook-signature': sign(reserialized) },
    });
    assert.equal(out.status, 401,
      'signing must be over the exact bytes received, not a round-tripped copy');
  });

  it('refuses a callback that names no call', async () => {
    const raw = body({ call_id: 'c1', status: 'completed' });
    const out = await handleBlandWebhook({
      callbackRef: '', rawBody: raw, headers: { 'x-webhook-signature': sign(raw) },
    });
    assert.equal(out.status, 400);
  });

  it('answers 404 for a correctly signed callback we have no record of', async () => {
    const raw = body({ call_id: 'c1', status: 'completed' });
    const out = await handleBlandWebhook({
      callbackRef: 'ref-nobody-has', rawBody: raw, headers: { 'x-webhook-signature': sign(raw) },
    });
    assert.equal(out.status, 404,
      'a valid signature still must not let an unknown reference touch any tenant');
  });

  it('refuses everything when no webhook secret is configured', async () => {
    const saved = process.env.BLAND_WEBHOOK_SECRET;
    delete process.env.BLAND_WEBHOOK_SECRET;
    try {
      const raw = body({ call_id: 'c1', status: 'completed' });
      const out = await handleBlandWebhook({
        callbackRef: 'ref', rawBody: raw, headers: { 'x-webhook-signature': sign(raw) },
      });
      assert.equal(out.status, 503,
        'an unconfigured verifier must reject, never accept unverified provider input');
    } finally { process.env.BLAND_WEBHOOK_SECRET = saved; }
  });
});

describe('running without a provider signature is a deliberate choice', () => {
  const raw = body({ call_id: 'c1', status: 'completed' });

  it('still refuses by default when no secret is set', async () => {
    const savedSecret = process.env.BLAND_WEBHOOK_SECRET;
    const savedFlag = process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
    delete process.env.BLAND_WEBHOOK_SECRET;
    delete process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
    try {
      const out = await handleBlandWebhook({ callbackRef: 'ref', rawBody: raw, headers: {} });
      assert.equal(out.status, 503,
        'the old system returned "verified" when no secret was set; unconfigured must mean refuse');
    } finally {
      process.env.BLAND_WEBHOOK_SECRET = savedSecret;
      if (savedFlag === undefined) delete process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
      else process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE = savedFlag;
    }
  });

  it('accepts on the unguessable reference alone only when explicitly opted out', async () => {
    const savedSecret = process.env.BLAND_WEBHOOK_SECRET;
    const savedFlag = process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
    delete process.env.BLAND_WEBHOOK_SECRET;
    process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE = 'false';
    try {
      const out = await handleBlandWebhook({ callbackRef: 'ref-nobody-has', rawBody: raw, headers: {} });
      assert.equal(out.status, 404,
        'it gets past auth and fails to match a call, rather than being refused at the door');
    } finally {
      process.env.BLAND_WEBHOOK_SECRET = savedSecret;
      if (savedFlag === undefined) delete process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
      else process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE = savedFlag;
    }
  });

  it('still enforces the signature when a secret IS set, opt-out or not', async () => {
    const savedFlag = process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
    process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE = 'false';
    try {
      const out = await handleBlandWebhook({ callbackRef: 'ref', rawBody: raw, headers: {} });
      assert.equal(out.status, 401,
        'a configured secret is never silently ignored');
    } finally {
      if (savedFlag === undefined) delete process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE;
      else process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE = savedFlag;
    }
  });
});

describe('the operator resource speaks the same field names as the modules it calls', () => {
  it('binds the provider id the client actually returns', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../src/tenant-cli/resources/voice.mjs', import.meta.url), 'utf8');
    assert.ok(!/placed\.callId\b/.test(src),
      'normalizeCall returns providerCallId; reading placed.callId placed a REAL call and then '
      + 'threw before the id could be stored, orphaning it');
    assert.ok(/placed\.providerCallId/.test(src));
    assert.ok(!/requested\.id\b/.test(src),
      'requestCall returns callId, not id');
  });
});

describe('a callback that matches nothing is not reported as recorded', () => {
  it('reads the projected field name the store actually returns', async () => {
    const fsp = await import('node:fs/promises');
    const src = await fsp.readFile(new URL('../src/voice/ingress.mjs', import.meta.url), 'utf8');
    assert.ok(/call\.callId/.test(src),
      'projectCall returns callId, not id; reading call.id passed undefined to '
      + 'recordProviderEvent, which matched nothing and recorded nothing');
    assert.ok(!/\bcall\.id\b/.test(src));
  });

  it('answers 404 rather than 200 when nothing matched', async () => {
    const src = await (await import('node:fs/promises'))
      .readFile(new URL('../src/voice/ingress.mjs', import.meta.url), 'utf8');
    assert.ok(/matched === false/.test(src),
      'returning 200 for an unmatched callback told Bland everything was fine while three '
      + 'real calls sat unsettled and no event was ever stored');
  });
});
