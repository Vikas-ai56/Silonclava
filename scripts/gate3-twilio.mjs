#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

process.env.ROCKY_PUBLIC_BASE_URL = process.env.ROCKY_PUBLIC_BASE_URL || 'https://gate3.example.test';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACgate3';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'gate3-auth-token';
process.env.TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const { computeSignature } = await import('../src/twilio-channel.mjs');
const { openTenantStore } = await import('../src/tenant-data/store.mjs');
const { TENANTS_DIR } = await import('../src/paths.mjs');
const {
  TWILIO_INBOUND_PATH,
  TWILIO_STATUS_PATH,
  signedWebhookUrl,
  handleTwilioInbound,
  handleTwilioStatus,
} = await import('../src/twilio-webhook.mjs');

const results = [];
let failures = 0;
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const received = [];
const channel = { onMessage: async (msg) => { received.push(msg); } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  const signedUrl = signedWebhookUrl(`${url.pathname}${url.search || ''}`);
  const signature = req.headers['x-twilio-signature'];
  const out = url.pathname === TWILIO_STATUS_PATH
    ? await handleTwilioStatus({ rawBody, signature, url: signedUrl, tenantId: url.searchParams.get('t'), openStore: openTenantStore })
    : await handleTwilioInbound({ rawBody, signature, url: signedUrl, channel });
  if (out.body === null) res.writeHead(out.status).end();
  else { res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function form(params) {
  return new URLSearchParams(params).toString();
}

async function post(pathAndQuery, params, { token = AUTH_TOKEN, tamper = null, omitSignature = false } = {}) {
  const signedUrl = signedWebhookUrl(pathAndQuery);
  const signature = computeSignature(signedUrl, params, token);
  const body = form(tamper ? { ...params, ...tamper } : params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!omitSignature) headers['x-twilio-signature'] = signature;
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { method: 'POST', headers, body });
  return { status: res.status };
}

function inboundParams(overrides = {}) {
  return {
    SmsMessageSid: 'SM00000000000000000000000000000001',
    MessageSid: 'SM00000000000000000000000000000001',
    AccountSid: 'ACgate3',
    From: 'whatsapp:+919632754524',
    To: 'whatsapp:+14155238886',
    Body: 'hello from gate 3',
    NumMedia: '0',
    ProfileName: 'K VIKAS',
    ...overrides,
  };
}

console.log('\nGATE 3 — Twilio inbound webhook under synthetic signed traffic\n');

console.log('Signature enforcement');
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams());
  step('correctly signed request is accepted', r.status === 204 && received.length === 1, `status=${r.status}`);
}
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams(), { tamper: { Body: 'tampered in flight' } });
  step('tampered body is rejected', r.status === 403 && received.length === 0, `status=${r.status}`);
}
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams(), { omitSignature: true });
  step('missing signature is rejected', r.status === 403 && received.length === 0, `status=${r.status}`);
}
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams(), { token: 'wrong-auth-token' });
  step('signature from a wrong auth token is rejected', r.status === 403 && received.length === 0, `status=${r.status}`);
}
{
  received.length = 0;
  const params = inboundParams();
  const signedUrl = signedWebhookUrl(TWILIO_INBOUND_PATH);
  const sig = computeSignature(`${signedUrl}/evil`, params, AUTH_TOKEN);
  const res = await fetch(`http://127.0.0.1:${port}${TWILIO_INBOUND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    body: form(params),
  });
  step('signature bound to a different URL is rejected', res.status === 403 && received.length === 0, `status=${res.status}`);
}

console.log('\nPayload correctness');
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams({
    Body: 'Deal value ₹45,00,000 — कृपया पुष्टि करें',
    From: 'whatsapp:+919876543210',
  }));
  const ok = r.status === 204 && received[0]?.text.includes('₹45,00,000') && received[0]?.text.includes('कृपया');
  step('non-ASCII body signs and round-trips intact', ok, received[0]?.text?.slice(0, 40) || `status=${r.status}`);
}
{
  received.length = 0;
  await post(TWILIO_INBOUND_PATH, inboundParams({
    OriginalRepliedMessageSid: 'SM00000000000000000000000000000099',
    OriginalRepliedMessageSender: 'whatsapp:+14155238886',
  }));
  const m = received[0];
  step('quoted-reply context is extracted (BL-008 inbound)',
    m?.replyToExternalId === 'SM00000000000000000000000000000099' && m?.replyToSender === '+14155238886',
    m?.replyToExternalId || 'absent');
}
{
  received.length = 0;
  await post(TWILIO_INBOUND_PATH, inboundParams());
  const m = received[0];
  step('sender normalised without the whatsapp: prefix',
    m?.from === '+919632754524' && m?.to === '+14155238886' && m?.channel === 'whatsapp', m?.from);
}
{
  received.length = 0;
  const r = await post(TWILIO_INBOUND_PATH, inboundParams({ From: '' }));
  step('missing From is rejected as a bad request', r.status === 400 && received.length === 0, `status=${r.status}`);
}
{
  received.length = 0;
  await post(TWILIO_INBOUND_PATH, inboundParams({ Body: '' }));
  step('empty body is accepted and normalised to empty text', received[0]?.text === '', JSON.stringify(received[0]?.text));
}

console.log('\nConcurrency and replay');
{
  received.length = 0;
  const senders = Array.from({ length: 25 }, (_, i) => `whatsapp:+9199000${String(i).padStart(5, '0')}`);
  const t0 = Date.now();
  const rs = await Promise.all(senders.map((From, i) => post(TWILIO_INBOUND_PATH, inboundParams({
    From,
    Body: `concurrent message ${i}`,
    MessageSid: `SM${String(i).padStart(32, '0')}`,
  }))));
  const ms = Date.now() - t0;
  const allOk = rs.every((r) => r.status === 204);
  const distinct = new Set(received.map((m) => m.from)).size;
  const noCrossTalk = received.every((m) => {
    const i = Number(m.text.replace('concurrent message ', ''));
    return m.from === senders[i].replace('whatsapp:', '');
  });
  step('25 concurrent senders all accepted', allOk && received.length === 25, `${received.length}/25 in ${ms}ms`);
  step('no cross-talk between concurrent senders', distinct === 25 && noCrossTalk, `${distinct} distinct senders`);
}
{
  received.length = 0;
  const params = inboundParams({ MessageSid: 'SM000000000000000000000000000REPLAY' });
  await post(TWILIO_INBOUND_PATH, params);
  await post(TWILIO_INBOUND_PATH, params);
  step('replayed webhook reaches the router twice (dedupe is downstream)',
    received.length === 2 && received[0].externalMessageId === received[1].externalMessageId,
    `${received.length} deliveries, same MessageSid`);
}

console.log('\nStatus callback');
{
  const statusParams = {
    MessageSid: 'SM00000000000000000000000000000001',
    MessageStatus: 'delivered',
    AccountSid: 'ACgate3',
  };
  const real = `br_gate3_${process.pid}`;
  openTenantStore(real).db.close();
  const r = await post(`${TWILIO_STATUS_PATH}?t=${real}`, statusParams);
  step('status callback signature is enforced over the query string', r.status === 204, `status=${r.status}`);
  const bad = await post(`${TWILIO_STATUS_PATH}?t=${real}`, statusParams, { token: 'wrong' });
  step('status callback with a bad signature is rejected', bad.status === 403, `status=${bad.status}`);
  const unscoped = await post(TWILIO_STATUS_PATH, statusParams);
  step('status callback without a tenant scope is accepted and ignored', unscoped.status === 204, `status=${unscoped.status}`);
  const unknown = await post(`${TWILIO_STATUS_PATH}?t=br_does_not_exist`, statusParams);
  step('status callback for an unknown tenant does not crash the handler', unknown.status === 204, `status=${unknown.status}`);
  const hostile = await post(`${TWILIO_STATUS_PATH}?t=${encodeURIComponent('../../etc/passwd')}`, statusParams);
  step('hostile tenant id in the query is refused without an error', hostile.status === 204, `status=${hostile.status}`);
  fs.rmSync(path.join(TENANTS_DIR, real), { recursive: true, force: true });
}

server.close();
console.log(`\n${failures === 0 ? 'GATE 3 PASSED' : 'GATE 3 FAILED'} — ${results.filter((r) => r.ok).length}/${results.length} checks\n`);
process.exit(failures === 0 ? 0 : 1);
