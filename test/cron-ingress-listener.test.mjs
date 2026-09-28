import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startCronIngressListener, detectBridgeGateway } from '../src/cron-ingress-listener.mjs';

const servers = [];
after(() => { for (const s of servers) { try { s.close(); } catch { /* closed */ } } });

const PORT = 8793;
const TOKEN = 'listener-test-token';

async function listener(bind = null) {
  process.env.ROCKY_CRON_WEBHOOK_TOKEN = TOKEN;
  const s = await startCronIngressListener({
    port: bind ? PORT + 1 : PORT,
    ...(bind ? { bind } : {}),
    channel: { sendText: async () => ({ ok: true, providerMessageId: 'M1', status: 'delivered' }) },
  });
  if (s) servers.push(s);
  return s;
}

// The production bind target is deliberately NOT reachable from the host on
// Linux: it binds the Docker bridge (172.17.0.1), which only containers can
// reach. Measured on the deployment host — container->bridge is 200, host->bridge
// times out. So the handler assertions run against an explicitly loopback-bound
// instance; the bind target itself is asserted separately below.
let handlerServer = null;
async function handlerBase() {
  if (!handlerServer) handlerServer = await listener('127.0.0.1');
  if (!handlerServer) return null;
  const { address, port } = handlerServer.address();
  return `http://${address}:${port}`;
}

describe('cron ingress listener', () => {
  it('binds somewhere containers can reach, not only loopback', async (t) => {
    const s = await listener();
    if (!s) { t.skip('could not bind'); return; }
    const addr = s.address();
    assert.notEqual(addr.address, '127.0.0.1', 'loopback is unreachable from a container');
  });

  it('rejects an unauthenticated POST', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 401);
  });

  it('rejects a wrong token', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: '{}',
    });
    assert.equal(r.status, 401);
  });

  it('serves only the cron path', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    for (const p of ['/health', '/api/tenants', '/signup/', '/']) {
      const r = await fetch(`${base}${p}`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}',
      });
      assert.equal(r.status, 404, `${p} must not be served by the cron listener`);
    }
  });

  it('rejects GET on the cron path', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 404);
  });

  it('refuses an unknown tenant even with a valid token', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery?t=br_nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jobId: 'j1', runId: 'r', summary: 'x' }),
    });
    assert.equal(r.status, 404);
  });

  it('rejects malformed json', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: 'not json',
    });
    assert.equal(r.status, 400);
  });
});

describe('container reachability wiring', () => {
  it('maps host.docker.internal so Linux containers can resolve the host', async () => {
    const dg = await fs.readFile('src/openclaw/docker-gateway.mjs', 'utf8');
    assert.match(dg, /'--add-host',\s*\n?\s*'host\.docker\.internal:host-gateway'/);
  });

  it('detects a bridge gateway or reports none', async () => {
    const ip = await detectBridgeGateway();
    if (ip !== null) assert.match(ip, /^\d+\.\d+\.\d+\.\d+$|^[a-z0-9.:-]+$/i);
  });
});

describe('the bridge listener identifies the tenant the same way', () => {
  it('refuses a delivery that names no tenant in the url', async (t) => {
    const base = await handlerBase();
    if (!base) { t.skip('could not bind loopback'); return; }
    const r = await fetch(`${base}/internal/cron/delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jobId: 'j1', runId: 'r', summary: 'x', tenantId: 'br_smuggled' }),
    });
    assert.equal(r.status, 400,
      'a tenant in the body is not authority — the url is');
  });
});
