import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyCronToken, handleCronDelivery } from './cron-ingress.mjs';
import { IS_PROD_PROFILE } from './config.mjs';
import { AGENT_MCP_PATH, handleAgentMcpRequest, tokenMatches } from './agent-mcp.mjs';
import { listTenants } from './tenants.mjs';
import { readGatewayMeta } from './openclaw/docker-gateway.mjs';

const execFileAsync = promisify(execFile);

let cachedBridgeGateway = null;

export function resetBridgeGatewayCache() {
  cachedBridgeGateway = null;
}

export async function detectBridgeGateway() {
  if (process.env.ROCKY_CRON_INGRESS_BIND) return process.env.ROCKY_CRON_INGRESS_BIND.trim();
  if (cachedBridgeGateway) return cachedBridgeGateway;
  try {
    const { stdout } = await execFileAsync('docker', [
      'network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
    ]);
    const ip = stdout.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
    cachedBridgeGateway = ip;
    return ip;
  } catch {
    return null;
  }
}

async function readBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Map a bearer token to the tenant that owns it. The token lives in the
 * tenant's gateway metadata, so a container can only ever act as itself — it
 * cannot name a tenant in the request.
 */
async function resolveAgentTenant(token) {
  if (!token) return null;
  for (const tenant of await listTenants()) {
    const meta = await readGatewayMeta(tenant.id);
    if (meta?.agentToken && tokenMatches(token, meta.agentToken)) return tenant.id;
  }
  return null;
}

export async function startCronIngressListener({ port, channel, bind = null }) {
  const address = bind || (await detectBridgeGateway());
  if (!address) {
    console.warn(
      '[cron] no Docker bridge address found — tenant containers cannot reach the cron ingress. ' +
        'Set ROCKY_CRON_INGRESS_BIND to the address containers should POST to.',
    );
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const requested = new URL(String(req.url || '/'), 'http://cron-ingress.invalid');
    const path = requested.pathname;

    // Rocky's own tools, served to tenant containers over MCP. It rides this
    // listener because this is already the one socket containers can reach and
    // the internet cannot — the Docker bridge.
    if (req.method === 'POST' && path === AGENT_MCP_PATH) {
      let message;
      try {
        message = JSON.parse(await readBody(req));
      } catch {
        return send(400, { error: 'invalid json' });
      }
      try {
        const out = await handleAgentMcpRequest({
          message,
          authorization: req.headers.authorization,
          resolveTenant: resolveAgentTenant,
        });
        if (out.body === null) return res.writeHead(out.status).end();
        return send(out.status, out.body);
      } catch (err) {
        console.error('[agent-mcp] request failed:', err?.message || err);
        return send(500, { error: 'agent mcp failed' });
      }
    }

    if (req.method !== 'POST' || path !== '/internal/cron/delivery') {
      return send(404, { error: 'not found' });
    }
    if (!verifyCronToken(req.headers.authorization)) return send(401, { error: 'unauthorized' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(400, { error: 'invalid json' });
    }
    try {
      const out = await handleCronDelivery(payload, channel, requested.searchParams.get('t'));
      return send(out.status, out.body);
    } catch (err) {
      console.error('[cron] delivery failed:', err?.message || err);
      return send(500, { error: 'delivery failed' });
    }
  });

  const listenOn = (host) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.on('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(server);
      });
    });

  try {
    await listenOn(address);
    console.log(`[cron] ingress listening on ${address}:${port}`);
    return server;
  } catch (err) {
    if (err?.code !== 'EADDRNOTAVAIL') {
      console.warn(`[cron] ingress listener on ${address}:${port} failed: ${err?.message || err}`);
      return null;
    }
  }

  if (IS_PROD_PROFILE) {
    console.warn(
      `[cron] ${address} is not a host interface and ROCKY_PROFILE=prod forbids the 0.0.0.0 ` +
        'fallback — cron delivery is disabled rather than bound wider than intended',
    );
    return null;
  }

  try {
    await listenOn('0.0.0.0');
    console.warn(
      `[cron] ${address} is not a host interface (Docker Desktop keeps the bridge inside its VM). ` +
        `Cron ingress bound to 0.0.0.0:${port} instead — it serves only the token-authed cron ` +
        'endpoint, but restrict it at the firewall on a shared network.',
    );
    return server;
  } catch (err) {
    console.warn(`[cron] ingress listener could not bind: ${err?.message || err}`);
    return null;
  }
}
