#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TENANT = arg('--tenant');
const DUE_IN_SEC = Number(arg('--due-in', '100'));
const KEEP = process.argv.includes('--keep');
const PORT = Number(arg('--port', '8795'));
const TOKEN = 'gate2-e2e-token';

if (!TENANT) {
  console.error('usage: node scripts/gate2-e2e.mjs --tenant <id> [--due-in 100] [--keep]');
  process.exit(2);
}

process.env.ROCKY_OPENCLAW_RUNTIME = 'docker';
process.env.ROCKY_CRON_WEBHOOK_TOKEN = TOKEN;
process.env.ROCKY_CRON_WEBHOOK_URL = `http://host.docker.internal:${PORT}/internal/cron/delivery`;
process.env.ROCKY_CRON_INGRESS_BIND = process.env.ROCKY_CRON_INGRESS_BIND || '0.0.0.0';

const steps = [];
let deliverySkipped = false;
const timings = {};
let failed = false;

function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function docker(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return `${stdout}${stderr}`;
}

async function dockerUp() {
  try {
    await execFileAsync('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

async function ensureDocker() {
  if (await dockerUp()) return true;
  console.log('  starting Docker Desktop…');
  await execFileAsync('open', ['-a', 'Docker']).catch(() => {});
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    if (await dockerUp()) return true;
  }
  return false;
}

/** Container start -> [gateway] ready, broken into entrypoint and gateway boot. */
async function readyTiming(name, timeoutMs = 90_000) {
  const t0 = Date.now();
  const startedAtRaw = (await docker(['inspect', name, '--format', '{{.State.StartedAt}}'])).trim();
  const startedAt = Date.parse(startedAtRaw);
  if (!Number.isFinite(startedAt)) return { ok: false, error: `unreadable StartedAt: ${startedAtRaw}` };

  const readLogs = () => docker(['logs', '--since', startedAtRaw, name]).catch(() => '');

  let logs = '';
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    logs = await readLogs();
    if (/\[gateway\] ready/.test(logs)) break;
    if (/Cannot find package|failed to start|Gateway failed|Permission denied/i.test(logs)) {
      return { ok: false, error: logs.slice(-400) };
    }
    if ((await docker(['inspect', name, '--format', '{{.State.Status}}']).catch(() => '')).trim() === 'exited') {
      return { ok: false, error: `container exited before ready: ${logs.slice(-400)}` };
    }
  }
  if (!/\[gateway\] ready/.test(logs)) return { ok: false, error: 'never reached ready' };

  const stamps = [...logs.matchAll(/(\d{4}-\d{2}-\d{2}T[\d:.]+[+Z][\d:]*)/g)].map((m) => Date.parse(m[1]));
  const firstLog = stamps.length ? Math.min(...stamps) : null;
  const readyLine = logs.split('\n').find((l) => l.includes('[gateway] ready'));
  const readyAt = readyLine ? Date.parse((readyLine.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+[+Z][\d:]*)/) || [])[1]) : null;
  const entrypointMs = firstLog && startedAt ? firstLog - startedAt : null;

  if (entrypointMs !== null && entrypointMs < 0) {
    return {
      ok: false,
      error: `stale logs: first line precedes StartedAt by ${-entrypointMs}ms — the ready line is from an earlier boot`,
    };
  }

  return {
    ok: true,
    wallMs: Date.now() - t0,
    entrypointMs,
    gatewayBootMs: readyAt && firstLog ? readyAt - firstLog : null,
  };
}

async function main() {
  console.log('\nGATE 2 — hibernate -> host wake -> cron fires -> delivered\n');

  // ---- environment -------------------------------------------------------
  console.log('Environment');
  if (!step('docker available', await ensureDocker())) return;

  const { OPENCLAW_DOCKER_IMAGE } = await import('../src/config.mjs');
  let haveImage = true;
  try {
    await execFileAsync('docker', ['image', 'inspect', OPENCLAW_DOCKER_IMAGE]);
  } catch {
    haveImage = false;
  }
  if (!haveImage) {
    console.log(`  building ${OPENCLAW_DOCKER_IMAGE}…`);
    await execFileAsync('npm', ['run', 'docker:build:openclaw'], { maxBuffer: 64 * 1024 * 1024 });
  }
  step('pinned image present', true, OPENCLAW_DOCKER_IMAGE);

  const { loadTenant } = await import('../src/tenants.mjs');
  const tenant = await loadTenant(TENANT);
  if (!step('tenant exists', Boolean(tenant), TENANT)) return;

  const { claudeCredentialPresentSync } = await import('../src/tenant-cli/runtime-credentials.mjs');
  step('tenant has Claude credentials', claudeCredentialPresentSync(TENANT));

  const { dockerContainerName, dockerContainerState } = await import('../src/openclaw/docker-gateway.mjs');
  const name = dockerContainerName(TENANT);

  // ---- ingress -----------------------------------------------------------
  const delivered = [];
  const { startCronIngressListener } = await import('../src/cron-ingress-listener.mjs');
  const channel = {
    sendText: async (to, text) => {
      delivered.push({ to, text, at: Date.now() });
      return { ok: true, providerMessageId: `gate2-${delivered.length}`, status: 'delivered' };
    },
  };
  const listener = await startCronIngressListener({ port: PORT, channel, bind: process.env.ROCKY_CRON_INGRESS_BIND });
  if (!step('cron ingress listening', Boolean(listener), `${process.env.ROCKY_CRON_INGRESS_BIND}:${PORT}`)) return;

  const { startTenantGatewayById, stopTenantGateway } = await import('../src/openclaw/tenant-gateway.mjs');
  const { openTenantStore } = await import('../src/tenant-data/store.mjs');
  const { tenantOpenclawStateDir } = await import('../src/openclaw/tenant-openclaw.mjs');
  const { refreshScheduleMirror, scheduledJobs } = await import('../src/tenant-data/cron-store.mjs');
  const { TURN_STATE } = await import('../src/tenant-data/migrations.mjs');
  const ws = await import('../src/wake-scheduler.mjs');

  let jobId = null;
  try {
    // ---- 1. cold create ---------------------------------------------------
    console.log('\nCold start');
    await docker(['rm', '-f', name]).catch(() => {});
    const createStart = Date.now();
    await startTenantGatewayById(TENANT);
    const created = await readyTiming(name);
    timings.coldCreateWallMs = Date.now() - createStart;
    timings.coldCreateEntrypointMs = created.entrypointMs;
    timings.coldCreateGatewayBootMs = created.gatewayBootMs;
    if (!step('container created and gateway ready', created.ok, `${timings.coldCreateWallMs}ms`)) return;

    // ---- 2. cron job ------------------------------------------------------
    console.log('\nCron job');
    const dueAt = new Date(Date.now() + DUE_IN_SEC * 1000);
    const cronExpr = `${dueAt.getUTCMinutes()} ${dueAt.getUTCHours()} * * *`;
    const addOut = await docker([
      'exec', name, 'openclaw', 'cron', 'add', cronExpr, 'Reply with exactly: GATE2-CRON-FIRED',
      '--name', 'gate2-e2e', '--webhook', process.env.ROCKY_CRON_WEBHOOK_URL,
    ]);
    jobId = (addOut.match(/"id"\s*:\s*"([^"]+)"/) || [])[1] || null;
    step('cron job created with webhook delivery', Boolean(jobId), jobId || addOut.slice(-120));

    const store1 = openTenantStore(TENANT);
    let mirrored = 0;
    try {
      mirrored = refreshScheduleMirror(store1, tenantOpenclawStateDir(TENANT)) || 0;
    } finally {
      store1.db.close();
    }
    step('schedule mirrored into Rocky', mirrored > 0, `${mirrored} job(s)`);

    // ---- 3. hibernate -----------------------------------------------------
    console.log('\nHibernate');
    const stopStart = Date.now();
    await stopTenantGateway(TENANT);
    timings.hibernateMs = Date.now() - stopStart;
    const state = (await docker(['inspect', name, '--format', '{{.State.Running}}']).catch(() => 'missing')).trim();
    step('container stopped (not removed)', state === 'false', `state=${state}, ${timings.hibernateMs}ms`);

    const store2 = openTenantStore(TENANT);
    let visible = [];
    try {
      visible = scheduledJobs(store2);
    } finally {
      store2.db.close();
    }
    step('schedule readable with container DOWN', visible.length > 0, `${visible.length} job(s)`);

    // ---- 4. host wake -----------------------------------------------------
    console.log('\nHost wake');
    const { isTenantWarm, warmTenantCount, maxWarmTenants } = await import('../src/openclaw/tenant-gateway.mjs');
    let wakeStart = null;
    ws.configureWakeScheduler({
      listTenants: async () => [{ id: TENANT }],
      openStore: (id) => openTenantStore(id),
      openclawDir: (id) => tenantOpenclawStateDir(id),
      isWarm: isTenantWarm,
      warmCount: warmTenantCount,
      maxWarm: maxWarmTenants,
      wake: async (id) => {
        wakeStart = Date.now();
        await startTenantGatewayById(id);
      },
      hibernate: async (id) => stopTenantGateway(id),
    });

    let ticked = { due: 0, started: [] };
    for (let i = 0; i < 40 && ticked.started.length === 0; i += 1) {
      ticked = await ws.tickOnce();
      if (ticked.started.length === 0) await sleep(5000);
    }
    step('wake scheduler decided to wake', ticked.started.includes(TENANT), `due=${ticked.due}`);

    const woken = await readyTiming(name);
    timings.wakeWallMs = wakeStart ? Date.now() - wakeStart : null;
    timings.wakeEntrypointMs = woken.entrypointMs;
    timings.wakeGatewayBootMs = woken.gatewayBootMs;
    step('container woken and gateway ready', woken.ok, `${timings.wakeWallMs}ms`);

    // ---- 5. delivery ------------------------------------------------------
    console.log('\nDelivery');
    const { cronWebhookReachable, CRON_WEBHOOK_URL } = await import('../src/config.mjs');
    const webhookUrl = process.env.ROCKY_CRON_WEBHOOK_URL || CRON_WEBHOOK_URL;
    if (!cronWebhookReachable(webhookUrl)) {
      console.log(`  SKIP  cron delivery — ${webhookUrl} is a private address.`);
      console.log("        OpenClaw's url-fetch guard refuses private/internal targets, so no");
      console.log('        container can reach it. Set ROCKY_PUBLIC_BASE_URL to the public origin');
      console.log('        and re-run to exercise delivery, the cron turn and the ledger.');
      deliverySkipped = true;
      return;
    }
    const waitStart = Date.now();
    while (delivered.length === 0 && Date.now() - waitStart < 300_000) await sleep(2000);
    timings.cronFireToDeliveryMs = delivered.length ? delivered[0].at - waitStart : null;
    if (!step('cron result reached the ingress and was delivered', delivered.length > 0,
      delivered.length ? `"${delivered[0].text.slice(0, 60)}"` : 'nothing delivered in 300s')) {
      console.log('\n  container tail:');
      console.log((await docker(['logs', '--tail', '25', name]).catch(() => '')).split('\n').map((l) => `    ${l.slice(0, 150)}`).join('\n'));
    }

    // ---- 6. ledger --------------------------------------------------------
    console.log('\nLedger');
    const store3 = openTenantStore(TENANT);
    try {
      const turn = store3.db
        .prepare("SELECT state, route, recipient FROM turns WHERE route = 'cron' ORDER BY id DESC LIMIT 1")
        .get();
      step('cron turn recorded', Boolean(turn), turn ? `state=${turn.state} route=${turn.route}` : 'none');
      step('turn reached a terminal state', Boolean(turn) &&
        [TURN_STATE.COMPLETED, TURN_STATE.SEND_STARTED].includes(turn.state), turn?.state);
      const msg = store3.db
        .prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'outbound'")
        .get();
      step('outbound message persisted', msg.n > 0, `${msg.n} outbound`);
    } finally {
      store3.db.close();
    }
  } finally {
    if (jobId && !KEEP) {
      // The container is hibernated by this point, so `docker exec` cannot run.
      // Bring it back before removing the job, or it survives to poison the next
      // gate run: two orphaned jobs from earlier runs kept firing, overran their
      // estimate and preempted a live interactive turn (measured 2026-09-20).
      if ((await dockerContainerState(name)) !== 'running') {
        await docker(['start', name]).catch(() => {});
        await sleep(6000);
      }
      const rm = await docker(['exec', name, 'openclaw', 'cron', 'rm', jobId]);
      const gone = (await docker(['exec', name, 'openclaw', 'cron', 'list']).catch(() => ''))
        .includes(jobId) === false;
      if (!gone) {
        console.warn(`\n  WARNING: cron job ${jobId} could not be removed — remove it before the next run`);
        console.warn(`  ${String(rm).slice(0, 200)}`);
      } else {
        console.log(`\n  cleaned up cron job ${jobId}`);
      }
    }
    listener?.close();
    ws.resetWakeScheduler();
    if (!KEEP) await stopTenantGateway(TENANT).catch(() => {});
  }

  // ---- report ------------------------------------------------------------
  console.log('\nLatency');
  const row = (k, v) => console.log(`  ${k.padEnd(34)} ${v == null ? 'n/a' : `${v}ms`}`);
  row('cold create -> ready (wall)', timings.coldCreateWallMs);
  row('  entrypoint share', timings.coldCreateEntrypointMs);
  row('  gateway boot share', timings.coldCreateGatewayBootMs);
  row('hibernate (docker stop)', timings.hibernateMs);
  row('WAKE -> ready (wall)', timings.wakeWallMs);
  row('  entrypoint share', timings.wakeEntrypointMs);
  row('  gateway boot share', timings.wakeGatewayBootMs);
  row('cron fire -> delivered', timings.cronFireToDeliveryMs);

  const lead = Number(process.env.ROCKY_WAKE_LEAD_MS || 60_000);
  if (timings.wakeWallMs != null) {
    console.log(`\n  WAKE_LEAD_MS is ${lead}ms; measured wake ${timings.wakeWallMs}ms ` +
      `(${(lead / timings.wakeWallMs).toFixed(1)}x margin)`);
  }

  const passed = steps.filter((s) => s.ok).length;
  if (deliverySkipped) {
    console.log('\n  4 delivery/ledger checks skipped — they need a publicly reachable ROCKY_PUBLIC_BASE_URL.');
  }
  console.log(`\n${failed ? 'GATE 2 FAILED' : 'GATE 2 PASSED'} — ${passed}/${steps.length} checks\n`);

  fs.mkdirSync(path.join(process.cwd(), 'ops'), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), 'ops', 'gate2-e2e.json'),
    `${JSON.stringify({ at: new Date().toISOString(), tenant: TENANT, passed: !failed, steps, timings }, null, 2)}\n`,
  );
  console.log('  evidence: ops/gate2-e2e.json\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nGATE 2 ERRORED:', err?.message || err);
  process.exit(1);
});
