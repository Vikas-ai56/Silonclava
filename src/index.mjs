import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MockChannel } from './channel.mjs';
import {
  attachRouter,
  recoverAllTenantLanes,
  resendAllCommittedResponses,
  invalidateToolState,
  lastRecipientFor,
} from './router.mjs';
import {
  reconcileContainers,
  startGatewaySupervisor,
  stopGatewaySupervisor,
  isTenantWarm,
  warmTenantCount,
  maxWarmTenants,
  startTenantGatewayById,
  stopTenantGateway,
  tenantInFlight,
} from './openclaw/tenant-gateway.mjs';
import { readParsedBody, readBodyBytes } from './http-body.mjs';
import { tenantOpenclawStateDir } from './openclaw/tenant-openclaw.mjs';
import { openTenantStore } from './tenant-data/store.mjs';
import {
  configureWakeScheduler,
  startWakeScheduler,
  stopWakeScheduler,
  wakeSchedulerStats,
} from './wake-scheduler.mjs';
import { signupFromWeb } from './onboarding.mjs';
import { listTenants, findTenantByPhone } from './tenants.mjs';
import { PUBLIC_DIR, ROOT } from './paths.mjs';
import {
  PUBLIC_BASE_URL,
  SESSION_IDLE_TTL_MS,
  OPERATOR_SESSION_IDLE_TTL_MS,
  OPENCLAW_WARM,
  OPENCLAW_GATEWAY_IDLE_MS,
  MAX_TENANTS_PER_HOST,
  OPENCLAW_DOCKER_IMAGE,
  ROCKY_PROFILE,
  ROCKY_INSTANCE_ID,
  IS_PROD_PROFILE,
  validateStartupSecurity,
  canSignupPhone,
  SHUTDOWN_GRACE_MS,
  CONNECTOR_SIDECAR_URL,
} from './config.mjs';
import {
  schedulerStats,
  beginDrain,
  drainActiveTurns,
  classifyUnresolvedTurns,
  closeTenantStores,
  setWriteToolsEnabled,
  wakeTenantLane,
} from './inbound-queue.mjs';
import {
  stopAllTenantGateways,
  warmGatewayStats,
  openclawRuntime,
} from './openclaw/tenant-gateway.mjs';
import { checkApiAuth, getApiToken } from './api-auth.mjs';
import { handleCronDelivery, verifyCronToken } from './cron-ingress.mjs';
import { startCronIngressListener } from './cron-ingress-listener.mjs';
import { readOrgMcpRegistry, writesEnabled } from './mcp/org-bundle.mjs';
import { completeOAuthCallback, inspectOAuthCallback } from './tenant-cli/index.mjs';
import { MEDIA_PATH_PREFIX, serveMedia } from './media-host.mjs';
import { configureAgentDelivery } from './agent-mcp.mjs';
import { configureActivationDelivery } from './tenant-activation.mjs';
import {
  getAdapter,
  knownProviders,
  inboundPathFor,
  statusPathFor,
  signedWebhookUrl,
  handleInboundWebhook,
  handleStatusWebhook,
  handleVerificationChallenge,
  providerCapabilities,
} from './channels/index.mjs';
import { enforceBodyLimit, withCapabilities } from './channels/port.mjs';

const PORT = Number(process.env.PORT || process.env.ROCKY_PORT || 8787);
const SHARED_NUMBER = process.env.ROCKY_SHARED_NUMBER || 'PENDING_PAIRING';

async function createChannel() {
  const requested = (process.env.ROCKY_CHANNEL || 'twilio').toLowerCase();
  if (requested === 'mock') {
    if (IS_PROD_PROFILE) throw new Error('ROCKY_PROFILE=prod forbids ROCKY_CHANNEL=mock');
    return { kind: 'mock', channel: new MockChannel() };
  }

  const adapter = getAdapter(requested);
  if (adapter) {
    if (!adapter.configured()) {
      throw new Error(`ROCKY_CHANNEL=${adapter.id} requires ${adapter.missingConfigMessage}`);
    }
    if (!PUBLIC_BASE_URL) {
      throw new Error(
        `ROCKY_CHANNEL=${adapter.id} requires ROCKY_PUBLIC_BASE_URL for webhook signature validation`,
      );
    }
    return {
      kind: adapter.id,
      channel: withCapabilities(
        enforceBodyLimit(
          adapter.createChannel({
            statusCallbackUrl: signedWebhookUrl(statusPathFor(adapter.id)),
          }),
          providerCapabilities(adapter.id),
        ),
        providerCapabilities(adapter.id),
      ),
    };
  }
  throw new Error(
    `Unknown ROCKY_CHANNEL=${requested}. Known providers: ${['mock', ...knownProviders()].join(', ')}`,
  );
}

const { kind: channelKind, channel: rawChannel } = await createChannel();
const channel = attachRouter(rawChannel);

// Tools that deliver to the user get the live channel and the tenant's own
// address from here — never from anything the model supplies.
configureAgentDelivery({
  channel,
  recipientFor: (tenantId) => lastRecipientFor(tenantId),
});
configureActivationDelivery({
  channel,
  recipientFor: (tenantId) => lastRecipientFor(tenantId),
});

// Boot reconciliation and recovery (SPEC-phase3c §3, §5), before the channel
// delivers anything: stop containers belonging to no known tenant, then return
// turns left mid-flight by a crash to `queued`.
{
  const known = (await listTenants()).map((t) => t.id);
  await reconcileContainers(known).catch((err) =>
    console.warn('[openclaw-gw] reconciliation skipped:', err?.message || err),
  );
  startGatewaySupervisor();

  // Host-owned wake scheduling (SPEC-phase3c §3a). Containers hibernate when
  // their user is idle; the host wakes them ahead of a due cron job, reading
  // its own schedule mirror rather than OpenClaw's internal state.
  configureWakeScheduler({
    listTenants,
    openStore: (id) => openTenantStore(id),
    openclawDir: (id) => tenantOpenclawStateDir(id),
    isWarm: isTenantWarm,
    warmCount: warmTenantCount,
    maxWarm: maxWarmTenants,
    wake: (id) => startTenantGatewayById(id),
    hibernate: (id) => stopTenantGateway(id),
    inFlight: (id) => tenantInFlight(id) > 0,
  });
  startWakeScheduler();
}
// §6 validity condition: with write-capable tools reachable, an interrupted
// turn must not be silently re-executed.
const orgRegistry = await readOrgMcpRegistry().catch(() => null);
const writesOn = orgRegistry ? writesEnabled(orgRegistry) : false;
setWriteToolsEnabled(writesOn);
if (writesOn) {
  console.warn(
    '[gateway] write-capable MCP tools are ENABLED — total re-execution is disabled; ' +
      'interrupted turns are marked UNCERTAIN_WRITE for review (tenant turn list)',
  );
}
await recoverAllTenantLanes({ writesEnabled: writesOn });
await resendAllCommittedResponses(channel).catch((err) =>
  console.warn('[queue] committed-response resend failed:', err?.message || err),
);

// The connector sidecar is required for every MCP action. Probe it at boot so a
// missing sidecar is loud here rather than a bare `fetch failed` on a user's
// first request. Never fatal: tenants without connected toolkits work fine.
(async () => {
  // Needs only the loopback URL — no credentials — so it deliberately does not
  // reach into the credential control plane.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${String(CONNECTOR_SIDECAR_URL).replace(/\/$/, '')}/health`, {
      signal: controller.signal,
    });
    // A 200 is not enough: the configured port may belong to something else
    // entirely. Require the connector to identify itself.
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.service === 'rocky-composio-connector') {
      console.log('[gateway] composio connector sidecar: healthy');
    } else if (res.ok) {
      console.warn(
        `[gateway] ${CONNECTOR_SIDECAR_URL} answered 200 but is NOT the composio connector ` +
          `(service=${body?.service ?? 'unidentified'}) — MCP actions will fail`,
      );
    } else {
      console.warn(`[gateway] composio connector sidecar returned HTTP ${res.status} — MCP actions will fail`);
    }
  } catch (err) {
    console.warn(
      `[gateway] composio connector sidecar UNREACHABLE (${err?.message || err}) — ` +
        'MCP actions will fail until it is up',
    );
  } finally {
    clearTimeout(timer);
  }
})();

/**
 * Verify a Composio OAuth return against the connector's own view, then tell
 * the user in the chat they started from. The browser tab is not where they are
 * waiting for the answer.
 */
async function confirmComposioConnection({ status, connectedAccountId, channel }) {
  if (String(status || '').toLowerCase() !== 'success' || !connectedAccountId) {
    return { ok: false, detail: 'That authorisation did not complete. Return to WhatsApp and try again.' };
  }

  const { createTenantClient } = await import('./tenant-cli/client.mjs');
  for (const tenant of await listTenants()) {
    let rows;
    try {
      rows = (await createTenantClient({ tenantId: tenant.id }).mcp().list())?.result?.connections || [];
    } catch {
      continue;
    }
    const match = rows.find((c) => c.connectionId === connectedAccountId);
    if (!match) continue;

    if (!match.connected) {
      return { ok: false, detail: `${match.toolkit} is still pending. Return to WhatsApp and try again.` };
    }
    // No container restart: the Composio MCP endpoint exposes a fixed tool set
    // and resolves toolkits server-side at call time, so connecting one changes
    // nothing the running agent can see. Measured: 6 tools with one toolkit
    // connected, still 6 with two. Only our own cached view was stale.
    invalidateToolState(tenant.id);

    const to = tenant.jid || tenant.phone;
    if (to && typeof channel?.sendText === 'function') {
      await channel
        .sendText(to, `${match.toolkit} is connected. You can ask me to use it now.`, { tenantId: tenant.id })
        .catch((err) => console.warn(`[connect] could not notify ${tenant.id}:`, err?.message || err));
    }
    console.log(`[connect] ${tenant.id}: ${match.toolkit} connected (${connectedAccountId})`);
    return { ok: true, detail: `${match.toolkit} is connected. You can close this tab and return to WhatsApp.` };
  }

  return { ok: false, detail: 'That connection could not be matched to a workspace.' };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function requireApiAuth(req, res) {
  const auth = checkApiAuth(req);
  if (!auth.ok) {
    json(res, auth.status, { ok: false, error: auth.error });
    return false;
  }
  return true;
}

async function serveStatic(res, urlPath) {
  let rel = urlPath.split('?')[0];
  if (rel === '/') rel = '/signup/';
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

function pairingPayload() {
  if (typeof channel.getPairingState === 'function') {
    return channel.getPairingState();
  }
  return {
    status: 'mock',
    qrDataUrl: null,
    connectedJid: null,
    error: null,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Cron delivery ingress (SPEC-phase3c §1.4b). Loopback + bearer token: the
    // tenant container posts its scheduled result here, and it joins the same
    // persist-then-send path as a user reply.
    if (req.method === 'POST' && url.pathname.startsWith('/webhooks/bland/')) {
      const { handleBlandWebhook } = await import('./voice/ingress.mjs');
      const callbackRef = decodeURIComponent(url.pathname.slice('/webhooks/bland/'.length));
      const rawBody = await readBodyBytes(req);
      const out = await handleBlandWebhook({ callbackRef, rawBody, headers: req.headers });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/internal/cron/delivery') {
      if (!verifyCronToken(req.headers.authorization)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let payload;
      try {
        payload = await readParsedBody(req);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      const out = await handleCronDelivery(payload, channel, url.searchParams.get('t'));
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
      return;
    }

    {
      const adapter = getAdapter(channelKind);
      if (adapter) {
        const inbound = inboundPathFor(adapter.id);
        const status = statusPathFor(adapter.id);
        if (url.pathname === inbound || url.pathname === status) {
          if (req.method === 'GET') {
            const challenge = await handleVerificationChallenge({
              adapter,
              searchParams: url.searchParams,
            });
            if (challenge) {
              res.writeHead(challenge.status, { 'content-type': 'text/plain' });
              res.end(String(challenge.body));
              return;
            }
          }
          if (req.method === 'POST') {
            const rawBody = await readRawBody(req);
            const signedUrl = signedWebhookUrl(`${url.pathname}${url.search || ''}`);
            const out = url.pathname === inbound
              ? await handleInboundWebhook({
                  adapter, rawBody, headers: req.headers, url: signedUrl, channel,
                })
              : await handleStatusWebhook({
                  adapter, rawBody, headers: req.headers, url: signedUrl,
                  searchParams: url.searchParams, openStore: openTenantStore,
                  onTurnSettled: wakeTenantLane,
                });
            if (out.body === null) {
              res.writeHead(out.status).end();
            } else {
              res.writeHead(out.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(out.body));
            }
            return;
          }
        }
      }
    }

    // Signed, expiring links to a tenant's own workspace files. Public because
    // Twilio fetches them itself; unguessable and short-lived because they are
    // tenant documents.
    if (req.method === 'GET' && url.pathname.startsWith(`${MEDIA_PATH_PREFIX}/`)) {
      const out = await serveMedia(url.pathname, url.searchParams);
      res.writeHead(out.status, out.headers || { 'Content-Type': 'text/plain' });
      if (out.body && typeof out.body.pipe === 'function') return out.body.pipe(res);
      return res.end(out.body || '');
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const auth = checkApiAuth(req);
      if (IS_PROD_PROFILE && !auth.ok) {
        return json(res, 200, { ok: true });
      }
      const pair = pairingPayload();
      return json(res, 200, {
        ok: true,
        profile: ROCKY_PROFILE,
        instanceId: ROCKY_INSTANCE_ID,
        channel: channelKind,
        status: pair.status,
        ...(IS_PROD_PROFILE && !auth.ok
          ? {}
          : {
              sharedNumber: SHARED_NUMBER,
              connectedJid: pair.connectedJid,
              publicBaseUrl: PUBLIC_BASE_URL,
              apiAuthConfigured: Boolean(getApiToken()),
              sessionIdleTtlMs: SESSION_IDLE_TTL_MS,
              operatorSessionIdleTtlMs: OPERATOR_SESSION_IDLE_TTL_MS,
              openclawWarm: OPENCLAW_WARM,
              openclawRuntime: openclawRuntime(),
              openclawDockerImage: OPENCLAW_DOCKER_IMAGE,
              openclawGatewayIdleMs: OPENCLAW_GATEWAY_IDLE_MS,
              openclawMaxWarm: MAX_TENANTS_PER_HOST,
              openclawWarmGateways: warmGatewayStats(),
              inboundQueue: schedulerStats(),
              wakeScheduler: wakeSchedulerStats(),
              lastDisconnect: rawChannel.lastDisconnect || null,
            }),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/connect/claude/session') {
      const state = url.searchParams.get('state') || '';
      let session;
      try {
        session = await inspectOAuthCallback('claude', state);
      } catch {
        session = null;
      }
      if (!session?.authorizeUrl) {
        return json(res, 400, {
          ok: false,
          error: 'Invalid or expired Claude login. Send “connect claude” on WhatsApp again.',
        });
      }
      return json(res, 200, {
        ok: true,
        authorizeUrl: session.authorizeUrl,
        state: session.state,
      });
    }

    if (req.method === 'GET' && url.pathname === '/connect/composio/callback') {
      // Composio returns ?status=success&connected_account_id=ca_...
      // The page used to claim "Connected" unconditionally and tell nobody, so
      // a failed authorisation looked identical to a successful one and the
      // user got no confirmation in the chat either way.
      const outcome = await confirmComposioConnection({
        status: url.searchParams.get('status'),
        connectedAccountId: url.searchParams.get('connected_account_id'),
        channel,
      });
      res.writeHead(outcome.ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        '<!doctype html><html><body style="font-family:system-ui;padding:2rem">' +
          `<h1>${outcome.ok ? 'Connected' : 'Not connected'}</h1><p>${outcome.detail}</p>` +
          '</body></html>',
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/connect/claude') {
      const body = await readParsedBody(req);
      const state = String(body.state || '').trim();
      const codeRaw = String(body.code || '').trim();
      let session;
      try {
        session = await inspectOAuthCallback('claude', state);
      } catch {
        session = null;
      }
      if (!session) {
        return json(res, 400, {
          ok: false,
          error: 'Invalid or expired Claude login. Send “connect claude” on WhatsApp again.',
        });
      }
      try {
        const command = await completeOAuthCallback('claude', { state, code: codeRaw });
        if (session.replyJid && typeof channel.sendText === 'function') {
          await channel.sendText(session.replyJid, command.result.message);
        }
        return json(res, 200, {
          ok: true,
          message: 'Connected. You can close this tab and return to WhatsApp.',
        });
      } catch (e) {
        console.error('[claude-oauth] connect failed', e);
        return json(res, 500, { ok: false, error: e.message || String(e) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/connect/llm') {
      return json(res, 410, {
        ok: false,
        error: 'Raw API-key intake is disabled. Send “connect claude” for tenant-owned subscription login.',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const pair = pairingPayload();
      return json(res, 200, {
        sharedNumber: SHARED_NUMBER,
        pairingReady: pair.status === 'open' || SHARED_NUMBER !== 'PENDING_PAIRING',
        channel: channelKind,
        status: pair.status,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/tenants') {
      if (!requireApiAuth(req, res)) return;
      const tenants = await listTenants();
      return json(
        res,
        200,
        tenants.map((t) => ({
          id: t.id,
          name: t.name,
          phone: t.phone,
          plan: t.plan,
          state: t.state,
          createdAt: t.createdAt,
        })),
      );
    }

    if (req.method === 'POST' && url.pathname === '/api/signup') {
      if (!requireApiAuth(req, res)) return;
      const body = await readParsedBody(req);
      try {
        if (!canSignupPhone(body.phone)) {
          return json(res, 403, {
            ok: false,
            error: IS_PROD_PROFILE
              ? 'Phone not on allowlist (ROCKY_ALLOW_FROM)'
              : 'Phone not on allowlist — set ROCKY_ALLOW_FROM or use ROCKY_PROFILE=dev',
          });
        }
        const { tenant, created } = await signupFromWeb({
          name: body.name,
          phone: body.phone,
          plan: body.plan,
          email: body.email,
        });
        const pair = pairingPayload();
        const liveNumber =
          SHARED_NUMBER !== 'PENDING_PAIRING'
            ? SHARED_NUMBER
            : pair.connectedJid
              ? `+${String(pair.connectedJid).split(':')[0].replace(/\D/g, '')}`
              : SHARED_NUMBER;
        return json(res, created ? 201 : 200, {
          ok: true,
          created,
          tenant: {
            id: tenant.id,
            name: tenant.name,
            phone: tenant.phone,
            plan: tenant.plan,
            state: tenant.state,
          },
          next: {
            sharedNumber: liveNumber,
            message:
              liveNumber === 'PENDING_PAIRING'
                ? 'Account provisioned. Shared WhatsApp number will be announced after pairing.'
                : `Message ${liveNumber} on WhatsApp to start.`,
          },
        });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message || String(err) });
      }
    }

    // Dev inject — mock channel only. Never expose on live Baileys.
    if (req.method === 'POST' && url.pathname === '/api/dev/message') {
      if (channelKind !== 'mock') {
        return json(res, 404, { ok: false, error: 'not found' });
      }
      if (!requireApiAuth(req, res)) return;
      const body = await readParsedBody(req);
      if (!body.from || body.text == null) {
        return json(res, 400, { ok: false, error: 'from and text required' });
      }
      const from = String(body.from).includes('@')
        ? String(body.from)
        : `${String(body.from).replace(/\D/g, '')}@s.whatsapp.net`;

      if (typeof channel.receive !== 'function') {
        return json(res, 500, { ok: false, error: 'mock channel receive unavailable' });
      }

      // A turn is queued and executed asynchronously, so `onMessage` resolves
      // with nothing — it did return a result when turns ran inline, which is
      // what this handler used to read. Accept the message, then wait briefly
      // for a reply to reach the mock channel so a local run is still useful.
      const before = (channel.sent || []).length;
      await channel.receive({ from, text: String(body.text) });

      const waitMs = Math.min(Number(body.waitMs ?? 20_000), 120_000);
      const deadline = Date.now() + waitMs;
      let replies = [];
      while (Date.now() < deadline) {
        replies = (channel.sent || []).slice(before).filter((m) => m.to === from);
        if (replies.length) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      return json(res, 202, {
        ok: true,
        accepted: true,
        from,
        replies,
        ...(replies.length ? {} : { note: 'no reply yet — the turn is still running; watch the log or `tenant turn list`' }),
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/tenants/')) {
      if (!requireApiAuth(req, res)) return;
      const phone = url.pathname.replace('/api/tenants/', '');
      const tenant = await findTenantByPhone(phone);
      if (!tenant) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { ok: true, tenant });
    }

    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    json(res, 500, { ok: false, error: err.message || String(err) });
  }
});

const startupErrors = validateStartupSecurity({ channelKind });
if (startupErrors.length) {
  for (const err of startupErrors) console.error(`[security] FATAL: ${err}`);
  process.exit(1);
}

await channel.start();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Rocky gateway (${channelKind}) profile=${ROCKY_PROFILE} instance=${ROCKY_INSTANCE_ID} on http://127.0.0.1:${PORT}`);
  console.log(`  Signup  → http://127.0.0.1:${PORT}/signup/`);
  console.log(`  Health  → http://127.0.0.1:${PORT}/health`);
  console.log(`  Public  → ${PUBLIC_BASE_URL}`);
  console.log(`  OAuth redirect → ${PUBLIC_BASE_URL}/oauth/google/callback`);
  console.log(`  API auth (ROCKY_API_TOKEN): ${getApiToken() ? 'configured' : 'MISSING — admin APIs locked'}`);
  console.log(`  Idle TTL tenants=${SESSION_IDLE_TTL_MS}ms operators=${OPERATOR_SESSION_IDLE_TTL_MS}ms`);
  console.log(
    `  OpenClaw warm=${OPENCLAW_WARM} runtime=${openclawRuntime()} always-on maxTenants=${MAX_TENANTS_PER_HOST || '∞'}`,
  );
  if (openclawRuntime() === 'docker') {
    startCronIngressListener({ port: PORT, channel }).catch((err) =>
      console.warn('[cron] ingress listener error:', err?.message || err),
    );
    console.log(`  OpenClaw image → ${OPENCLAW_DOCKER_IMAGE} (per-tenant containers)`);
  }
  console.log('  WhatsApp: connect claude | connect gmail | check inbox');
  // Only advertise it when it is actually reachable. The endpoint is mock-only
  // by design — injecting against a live provider would send a real message —
  // so announcing it on a Twilio boot sends the reader looking for a 404.
  if (channelKind === 'mock') {
    console.log('  Dev msg → POST /api/dev/message (Bearer ROCKY_API_TOKEN required)');
  } else {
    console.log(`  Dev msg → disabled on the ${channelKind} channel; boot with ROCKY_CHANNEL=mock to inject`);
  }
});

let shuttingDown = false;
/**
 * Graceful shutdown in the order SPEC-phase3c §8 requires.
 *
 * The previous implementation stopped gateways first, before intake closed or
 * turns drained — the exact inversion §8 forbids, because it kills the runtime
 * out from under work that is still in flight and leaves the turn ledger
 * claiming those turns are running.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const graceMs = SHUTDOWN_GRACE_MS;
  console.log(`[gateway] ${signal} — draining (grace ${graceMs}ms)`);

  // 1-2. Stop accepting and stop claiming.
  const pending = beginDrain();
  stopWakeScheduler();
  stopGatewaySupervisor();
  try {
    if (typeof channel.pause === 'function') await channel.pause();
  } catch (err) {
    console.warn('[gateway] channel pause:', err?.message || err);
  }

  // 3. Let active turns and their delivery commits settle.
  const drained = await drainActiveTurns(graceMs);
  if (drained.timedOut) {
    console.warn(`[gateway] ${drained.remaining} turn(s) still active after grace`);
  }

  // 4. Classify whatever did not settle.
  const classified = classifyUnresolvedTurns();
  if (classified.requeued || classified.unknown) {
    console.log(
      `[gateway] requeued ${classified.requeued} pre-commit turn(s); ` +
        `marked ${classified.unknown} delivery_unknown`,
    );
  }

  // 5. Checkpoint and close tenant databases before their containers stop.
  const closed = closeTenantStores();
  console.log(`[gateway] closed ${closed} tenant database(s) (queued was ${pending.queued})`);

  // 6. Gateways, then the HTTP server, then exit.
  try {
    await stopAllTenantGateways();
  } catch (err) {
    console.warn('[gateway] warm gateway stop:', err?.message || err);
  }
  try {
    if (typeof channel.stop === 'function') await channel.stop();
  } catch (err) {
    console.warn('[gateway] channel stop:', err?.message || err);
  }
  try {
    server.close();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error(err);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error(err);
    process.exit(1);
  });
});
