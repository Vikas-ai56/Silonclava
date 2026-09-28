#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const LIVE = process.argv.includes('--live');
const TENANT = (() => {
  const i = process.argv.indexOf('--tenant');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'br_cf0f90312d9e';
})();
const TURN_TIMEOUT_MS = Number(process.env.GATE3_TURN_TIMEOUT_MS || 180_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function portOpen(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 500);
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

const outbound = [];
const twilioMock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const params = Object.fromEntries(new URLSearchParams(body));
  outbound.push({ path: req.url, params, auth: req.headers.authorization || '' });
  const sid = `SM${String(outbound.length).padStart(32, '0')}`;
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sid, status: 'queued', date_created: new Date().toUTCString() }));
});

let rocky;
try {
  console.log(`\nGATE 3 LOCAL — signed inbound -> tenant -> container -> outbound${LIVE ? '  [LIVE: real Twilio]' : '  [mocked Twilio API]'}\n`);

  const mockPort = await freePort();
  if (!LIVE) await new Promise((r) => twilioMock.listen(mockPort, '127.0.0.1', r));
  const rockyPort = await freePort();
  const publicBase = `http://127.0.0.1:${rockyPort}`;

  console.log('Boot');
  const env = {
    ...process.env,
    ROCKY_CHANNEL: 'twilio',
    ROCKY_PROFILE: 'dev',
    ROCKY_OPENCLAW_RUNTIME: 'docker',
    ROCKY_PUBLIC_BASE_URL: publicBase,
    PORT: String(rockyPort),
    ROCKY_PORT: String(rockyPort),
    ...(LIVE ? {} : { TWILIO_API_ROOT: `http://127.0.0.1:${mockPort}/2010-04-01` }),
  };

  rocky = spawn('node', ['src/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rockyLog = [];
  const capture = (c) => {
    const text = c.toString();
    rockyLog.push(text);
    if (process.env.GATE3_VERBOSE) process.stdout.write(`    | ${text}`);
  };
  rocky.stdout.on('data', capture);
  rocky.stderr.on('data', capture);

  if (!step('rocky started with the twilio channel', await portOpen(rockyPort, 40_000), publicBase)) {
    console.log(rockyLog.join('').slice(-1500));
    throw new Error('rocky did not listen');
  }
  const bootLog = rockyLog.join('');
  step('channel selected is twilio, not baileys', /\(twilio\)/.test(bootLog),
    (bootLog.match(/Rocky gateway \((\w+)\)/) || [])[1] || 'unknown');

  const { computeSignature } = await import('../src/twilio-channel.mjs');
  const { TWILIO_INBOUND_PATH } = await import('../src/twilio-webhook.mjs');

  async function sendInbound(text, extra = {}) {
    const sid = `SM${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 34);
    const params = {
      MessageSid: sid,
      SmsMessageSid: sid,
      AccountSid: process.env.TWILIO_ACCOUNT_SID || 'AC0',
      From: 'whatsapp:+919632754524',
      To: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+16288886030',
      Body: text,
      NumMedia: '0',
      ...extra,
    };
    const url = `${publicBase}${TWILIO_INBOUND_PATH}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': computeSignature(url, params, process.env.TWILIO_AUTH_TOKEN),
      },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, sid };
  }

  console.log('\nInbound');
  const bad = await fetch(`${publicBase}${TWILIO_INBOUND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' },
    body: 'From=whatsapp%3A%2B919632754524&Body=hi',
  });
  step('unsigned request rejected by the live server', bad.status === 403, `status=${bad.status}`);

  const t0 = Date.now();
  const sent = await sendInbound('Reply with exactly: GATE3-LOCAL-OK');
  step('signed request accepted by the live server', sent.status === 204, `status=${sent.status}`);

  console.log('\nTurn');
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (outbound.length === 0 && Date.now() < deadline && !LIVE) await sleep(1000);
  const turnMs = Date.now() - t0;

  if (!LIVE) {
    if (!step('a reply was sent through the twilio channel', outbound.length > 0, `${turnMs}ms`)) {
      console.log('\n  rocky log tail:');
      console.log(rockyLog.join('').slice(-2000).split('\n').map((l) => `    ${l}`).join('\n'));
    } else {
      const call = outbound[0];
      step('outbound hit the Messages endpoint', /\/Messages\.json$/.test(call.path), call.path);
      step('outbound used basic auth, not a token in the URL',
        call.auth.startsWith('Basic ') && !call.path.includes('AuthToken'), call.auth.slice(0, 6));
      step('outbound addressed the original sender',
        call.params.To === 'whatsapp:+919632754524', call.params.To);
      step('outbound carried a non-empty body', Boolean(call.params.Body?.trim()),
        `${(call.params.Body || '').slice(0, 60)}…`);
      step('status callback is tenant-scoped',
        !call.params.StatusCallback || /[?&]t=/.test(call.params.StatusCallback),
        call.params.StatusCallback || '(none configured)');
    }
  }

  console.log('\nStatus callback closes the turn');
  if (!LIVE && outbound.length) {
    const { TWILIO_STATUS_PATH } = await import('../src/twilio-webhook.mjs');
    const providerSid = `SM${String(1).padStart(32, '0')}`;
    const cbParams = {
      MessageSid: providerSid,
      MessageStatus: 'delivered',
      AccountSid: process.env.TWILIO_ACCOUNT_SID || 'AC0',
    };
    const cbPath = `${TWILIO_STATUS_PATH}?t=${encodeURIComponent(TENANT)}`;
    const cbUrl = `${publicBase}${cbPath}`;
    const cb = await fetch(cbUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': computeSignature(cbUrl, cbParams, process.env.TWILIO_AUTH_TOKEN),
      },
      body: new URLSearchParams(cbParams).toString(),
    });
    step('signed delivery callback accepted', cb.status === 204, `status=${cb.status}`);
  }

  console.log('\nLedger');
  const { openTenantStore } = await import('../src/tenant-data/store.mjs');
  const store = openTenantStore(TENANT);
  try {
    const inbound = store.db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE direction='inbound' AND external_message_id = ?",
    ).get(sent.sid);
    step('inbound message persisted with its provider id', inbound.c === 1, `${inbound.c} row(s)`);

    const terminal = ['completed', 'delivery_unknown', 'failed'];
    let turn = null;
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      turn = store.db.prepare('SELECT state, route FROM turns ORDER BY id DESC LIMIT 1').get();
      if (terminal.includes(turn?.state)) break;
      await sleep(500);
    }
    step('turn reached a terminal state', terminal.includes(turn?.state), turn?.state || 'no turn');

    const out = store.db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE direction='outbound'",
    ).get();
    step('outbound message persisted before send', out.c > 0, `${out.c} outbound`);
  } finally {
    store.db.close();
  }

  console.log('\nTiming');
  console.log(`  inbound webhook -> reply sent   ${turnMs}ms`);
} catch (err) {
  console.error('\nGATE 3 LOCAL ERROR:', err?.message || err);
  failures += 1;
} finally {
  if (rocky) {
    rocky.kill('SIGTERM');
    const gone = await Promise.race([
      new Promise((r) => rocky.once('exit', () => r(true))),
      sleep(15_000).then(() => false),
    ]);
    if (!gone) rocky.kill('SIGKILL');
  }
  twilioMock.close();
}

console.log(`\n${failures === 0 ? 'GATE 3 LOCAL PASSED' : 'GATE 3 LOCAL FAILED'} — ${results.filter((r) => r.ok).length}/${results.length} checks\n`);
process.exit(failures === 0 ? 0 : 1);
