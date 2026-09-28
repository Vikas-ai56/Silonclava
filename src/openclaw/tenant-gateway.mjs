import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  OPENCLAW_BIN,
  OPENCLAW_DOCKER_IMAGE,
  OPENCLAW_GATEWAY_PORT_BASE,
  OPENCLAW_GATEWAY_IDLE_MS,
  MAX_TENANTS_PER_HOST,
  OPENCLAW_WARM,
  effectiveOpenclawRuntime,
} from '../config.mjs';
import { stripAnthropicStaticEnv } from '../tenant-cli/runtime-credentials.mjs';
import { createTenantRuntimeClient } from '../tenant-cli/client.mjs';
import { tenantDir } from '../tenants.mjs';
import { assertPinnedSpawnRuntime } from './tenant-openclaw.mjs';
import { admit } from './admission.mjs';
import { runTenantOnboarding, PHASE } from './tenant-onboarding.mjs';
import { clearTenantComposioRuntime } from '../mcp/composio-runtime.mjs';
import {
  dockerContainerName,
  dockerContainerState,
  dockerLogsTail,
  dockerRemoveContainer,
  dockerRunGateway,
  quarantineForeignPathState,
  containerMatchesCurrentSpec,
  assertImageContract,
  dockerStartContainer,
  dockerStopContainer,
  readGatewayMeta,
  listRockyContainers,
  tenantIdFromContainerName,
} from './docker-gateway.mjs';

const execFileAsync = promisify(execFile);

/**
 * @typedef {{
 *   child: import('node:child_process').ChildProcess | null,
 *   containerName: string | null,
 *   runtime: 'spawn' | 'docker',
 *   port: number,
 *   token: string,
 *   startedAt: number,
 *   generation: number,
 *   inFlight: number,
 *   starting: Promise<any> | null,
 * }} PoolEntry
 */

/** @type {Map<string, PoolEntry>} */
const pool = new Map();

/** After a failed start, skip re-spawn for this long (use --local instead). */
const WARM_FAIL_COOLDOWN_MS = Number(process.env.ROCKY_OPENCLAW_WARM_FAIL_COOLDOWN_MS || 90_000);
/** First boot / migrations can exceed 45s on Windows. */
const WARM_READY_TIMEOUT_MS = Number(process.env.ROCKY_OPENCLAW_WARM_READY_MS || 120_000);

/** @type {Map<string, number>} */
const lastFailAt = new Map();

async function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
      await sleep(300);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  } catch {
    // already dead
  }
}

export class HostCapacityExceededError extends Error {
  constructor(max) {
    super(`Cannot admit another tenant: host capacity ${max} reached`);
    this.name = 'HostCapacityExceededError';
    this.code = 'HOST_CAPACITY_EXCEEDED';
  }
}

let isCronWarm = () => false;
let rhythmFor = () => undefined;
let onCronEvicted = () => false;

export function configureAdmission({ cronWarm, rhythm, cronEvicted } = {}) {
  if (typeof cronWarm === 'function') isCronWarm = cronWarm;
  if (typeof rhythm === 'function') rhythmFor = rhythm;
  if (typeof cronEvicted === 'function') onCronEvicted = cronEvicted;
}

function admissionEntries() {
  return [...pool.entries()].map(([tenantId, entry]) => ({
    tenantId,
    inFlight: entry.inFlight || 0,
    startedAt: entry.startedAt || 0,
    lastUserRequestAt: entry.lastUserRequestAt || entry.startedAt || 0,
    typicalGapMs: rhythmFor(tenantId),
    cron: Boolean(isCronWarm(tenantId)),
  }));
}

export function admitTenant(tenantId) {
  return admit(tenantId, {
    hasWarm: (id) => pool.has(id),
    warmCount: () => pool.size,
    maxWarm: () => maxWarmTenants(),
    listEntries: admissionEntries,
    stop: async (id) => {
      if (isCronWarm(id)) onCronEvicted(id);
      await stopTenantGateway(id);
    },
  });
}

export function assertHostCapacity(tenantId) {
  const max = MAX_TENANTS_PER_HOST;
  if (!max || max < 1) return;
  if (pool.has(tenantId)) return;
  if (pool.size >= max) throw new HostCapacityExceededError(max);
}

export function isOpenclawWarmEnabled() {
  return OPENCLAW_WARM;
}

export function openclawRuntime() {
  return effectiveOpenclawRuntime();
}

export function tenantGatewayPort(tenantId, base = OPENCLAW_GATEWAY_PORT_BASE) {
  const s = String(tenantId || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return base + (h >>> 0) % 900;
}

export function gatewayWsUrl(port) {
  return `ws://127.0.0.1:${Number(port)}`;
}

function resolveOpenclawSpawn() {
  const configured = String(OPENCLAW_BIN || 'openclaw').trim();
  if (configured.endsWith('.mjs') || configured.endsWith('.js')) {
    return { command: process.execPath, argsPrefix: [configured], useShell: false };
  }

  const appData = process.env.APPDATA || '';
  const npmEntry = path.join(appData, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
  if (appData && fs.existsSync(npmEntry)) {
    return { command: process.execPath, argsPrefix: [npmEntry], useShell: false };
  }

  return {
    command: configured,
    argsPrefix: [],
    useShell: process.platform === 'win32',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function portListening(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitUntilListening(port, timeoutMs, isDead) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDead && (await isDead())) return false;
    if (await portListening(port)) return true;
    await sleep(500);
  }
  return false;
}

async function waitUntilHttpReady(port, token, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-openclaw-scopes': 'operator.read,operator.write,operator.admin',
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status > 0) return true;
    } catch {
      // not ready yet
    }
    await sleep(400);
  }
  return false;
}

async function findFreePort(preferred) {
  const base = Number(preferred);
  for (let i = 0; i < 40; i++) {
    const port = base + i;
    if (!(await portListening(port))) return port;
  }
  throw new Error(`No free OpenClaw gateway port near ${preferred}`);
}

const generations = new Map();

function nextGeneration(tenantId) {
  const next = (generations.get(tenantId) || 0) + 1;
  generations.set(tenantId, next);
  return next;
}

function seedGeneration(tenantId, persisted) {
  const value = Number(persisted || 0);
  if (!Number.isFinite(value) || value <= 0) return;
  generations.set(tenantId, Math.max(generations.get(tenantId) || 0, value));
}

export function acquireTenantRuntime(tenantId) {
  const entry = pool.get(tenantId);
  if (!entry) return null;
  entry.inFlight += 1;
  return {
    tenantId,
    runtimeId: entry.containerName || `spawn:${entry.port}`,
    generation: entry.generation,
  };
}

export function releaseTenantRuntime(tenantId) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
}

export function isCurrentGeneration(tenantId, generation) {
  const entry = pool.get(tenantId);
  if (!entry) return false;
  return entry.generation === generation;
}

export function tenantInFlight(tenantId) {
  return pool.get(tenantId)?.inFlight || 0;
}

export function totalInFlight() {
  let n = 0;
  for (const entry of pool.values()) n += entry.inFlight;
  return n;
}

function touchEntry(tenantId) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  entry.startedAt = entry.startedAt || Date.now();
  entry.lastUserRequestAt = Date.now();
  scheduleIdleStop(tenantId);
}

function clearIdleTimer(entry) {
  if (entry?.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function scheduleIdleStop(tenantId) {
  const entry = pool.get(tenantId);
  if (!entry) return;
  clearIdleTimer(entry);
  if (!OPENCLAW_GATEWAY_IDLE_MS || OPENCLAW_GATEWAY_IDLE_MS < 1) return;
  entry.idleTimer = setTimeout(() => {
    const cur = pool.get(tenantId);
    if (cur && cur.inFlight > 0) {
      scheduleIdleStop(tenantId);
      return;
    }
    console.log(
      `[openclaw-gw] tenant ${tenantId}: idle ${OPENCLAW_GATEWAY_IDLE_MS}ms — hibernating`,
    );
    stopTenantGateway(tenantId).catch((err) =>
      console.warn(`[openclaw-gw] hibernate failed for ${tenantId}:`, err?.message || err),
    );
  }, OPENCLAW_GATEWAY_IDLE_MS);
  if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
}

export function warmTenantCount() {
  return pool.size;
}

export function isTenantWarm(tenantId) {
  return pool.has(tenantId);
}

export function maxWarmTenants() {
  return MAX_TENANTS_PER_HOST || Number.POSITIVE_INFINITY;
}

async function entryIsLive(entry) {
  if (!entry?.port) return false;
  if (!(await portListening(entry.port))) return false;
  if (entry.runtime === 'docker') {
    if (!entry.containerName) return false;
    return (await dockerContainerState(entry.containerName)) === 'running';
  }
  return Boolean(entry.child && !entry.child.killed && entry.child.exitCode == null);
}

async function spawnGateway({ tenantId, port, token, env }) {
  assertPinnedSpawnRuntime();
  const { command, argsPrefix, useShell } = resolveOpenclawSpawn();
  const args = [
    ...argsPrefix,
    'gateway',
    'run',
    '--port',
    String(port),
    '--bind',
    'loopback',
    '--auth',
    'token',
    '--token',
    token,
  ];

  const child = spawn(command, args, {
    cwd: env.OPENCLAW_WORKSPACE_DIR || process.cwd(),
    env: stripAnthropicStaticEnv({
      ...process.env,
      ...env,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_TOKEN: token,
    }),
    shell: Boolean(useShell),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  const onLog = (chunk) => {
    const text = chunk.toString();
    stderrTail = `${stderrTail}${text}`.slice(-4000);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      console.log(`[openclaw-gw:${tenantId}] ${line.slice(0, 300)}`);
    }
  };
  child.stderr?.on('data', onLog);
  child.stdout?.on('data', onLog);

  child.on('exit', (code, signal) => {
    const cur = pool.get(tenantId);
    if (cur?.child === child) {
      pool.delete(tenantId);
      console.warn(
        `[openclaw-gw] tenant ${tenantId}: gateway exited code=${code} signal=${signal || ''}`,
      );
      clearTenantComposioRuntime(tenantId).catch(() => { });
    }
  });

  const bootEntry = pool.get(tenantId) || {
    child: null,
    containerName: null,
    runtime: 'spawn',
    port,
    token,
    startedAt: Date.now(),
    lastUserRequestAt: 0,
    idleTimer: null,
    generation: nextGeneration(tenantId),
    inFlight: 0,
    starting: null,
  };
  bootEntry.child = child;
  bootEntry.runtime = 'spawn';
  bootEntry.containerName = null;
  bootEntry.port = port;
  bootEntry.token = token;
  pool.set(tenantId, bootEntry);

  console.log(
    `[openclaw-gw] tenant ${tenantId}: waiting up to ${WARM_READY_TIMEOUT_MS}ms for :${port}`,
  );
  const ready = await waitUntilListening(port, WARM_READY_TIMEOUT_MS, async () =>
    Boolean(child.killed || child.exitCode != null),
  );
  if (!ready) {
    await killProcessTree(child.pid);
    await sleep(800);
    throw new Error(
      `OpenClaw gateway for tenant ${tenantId} did not listen on ${port}` +
      (stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ''),
    );
  }

  return child;
}

async function startDockerGateway({ tenantId, preferredPort }) {
  const name = dockerContainerName(tenantId);
  const meta = await readGatewayMeta(tenantId);
  seedGeneration(tenantId, meta?.generation);

  const state = await dockerContainerState(name);
  if (state === 'running' || state === 'exited') {
    const spec = await containerMatchesCurrentSpec(name, tenantId);
    if (!spec.matches) {
      console.warn(
        `[openclaw-gw] tenant ${tenantId}: container ${name} is stale (${spec.reason}) — recreating`,
      );
      await dockerRemoveContainer(name);
    }
  }

  if ((await dockerContainerState(name)) === 'running' && meta?.port && meta?.token) {
    if (await portListening(meta.port)) {
      return { port: meta.port, token: meta.token, containerName: name, warmed: true };
    }
  }

  if ((await dockerContainerState(name)) === 'exited' && meta?.port && meta?.token) {
    const wake = await runTenantOnboarding(PHASE.WAKE, {
      tenantId,
      containerName: name,
      rehydrateProjection: async (id) => {
        const canonicalConfigPath = path.join(tenantDir(id), 'openclaw', 'openclaw.json');
        await createTenantRuntimeClient({ tenantId: id }).hydrateMcp(canonicalConfigPath);
      },
    });
    if (!wake.ok) {
      console.warn(`[openclaw-gw] tenant ${tenantId}: wake preconditions failed — recreating container`);
      await dockerRemoveContainer(name);
    } else {
      console.log(`[openclaw-gw] tenant ${tenantId}: docker start ${name}`);
      await dockerStartContainer(name);
      const ready = await waitUntilListening(meta.port, WARM_READY_TIMEOUT_MS, async () => {
        const st = await dockerContainerState(name);
        return st !== 'running';
      });
      const httpReady =
        ready &&
        (await dockerContainerState(name)) === 'running' &&
        (await waitUntilHttpReady(meta.port, meta.token, 30_000));
      if (httpReady) {
        return { port: meta.port, token: meta.token, containerName: name, warmed: true };
      }
      await dockerStopContainer(name);
      const logs = await dockerLogsTail(name);
      throw new Error(
        `Docker gateway ${name} started but did not listen on ${meta.port}` +
        (logs ? `: ${logs.slice(-400)}` : ''),
      );
    }
  }

  await assertImageContract();

  const port = await findFreePort(preferredPort);
  const token = crypto.randomBytes(24).toString('hex');

  const onboarding = await runTenantOnboarding(PHASE.CREATE, { tenantId, containerName: name });
  if (!onboarding.ok) {
    const failed = onboarding.results.find((r) => !r.ok);
    throw new Error(`Tenant onboarding failed at "${failed?.name}": ${failed?.detail}`);
  }

  try {
    quarantineForeignPathState(tenantId);
  } catch (err) {
    console.warn(`[openclaw-gw] tenant ${tenantId}: state scan failed:`, err?.message || err);
  }

  console.log(
    `[openclaw-gw] tenant ${tenantId}: docker run ${name} image=${OPENCLAW_DOCKER_IMAGE} port=${port}`,
  );
  await dockerRunGateway({
    tenantId,
    port,
    token,
    image: OPENCLAW_DOCKER_IMAGE,
  });

  const ready = await waitUntilListening(port, WARM_READY_TIMEOUT_MS, async () => {
    const st = await dockerContainerState(name);
    return st !== 'running';
  });
  await sleep(800);
  const stillRunning = (await dockerContainerState(name)) === 'running';
  const httpReady = stillRunning && (await waitUntilHttpReady(port, token, 30_000));
  if (!ready || !stillRunning || !httpReady) {
    const logs = await dockerLogsTail(name);
    await dockerStopContainer(name).catch(() => { });
    throw new Error(
      `Docker OpenClaw gateway for tenant ${tenantId} did not stay up on ${port}` +
      (logs ? `: ${logs.slice(-500)}` : ''),
    );
  }

  return { port, token, containerName: name, warmed: false };
}

export async function ensureTenantGateway(tenant, runCtx) {
  if (!OPENCLAW_WARM) {
    throw new Error('OpenClaw warm gateway disabled');
  }

  const tenantId = tenant.id;
  const existing = pool.get(tenantId);

  if (existing?.starting) {
    await existing.starting;
    const after = pool.get(tenantId);
    if (after && (await entryIsLive(after))) {
      touchEntry(tenantId);
      return {
        port: after.port,
        token: after.token,
        url: gatewayWsUrl(after.port),
        warmed: true,
        runtime: after.runtime,
      };
    }
  }

  const live = pool.get(tenantId);
  if (live && (await entryIsLive(live))) {
    touchEntry(tenantId);
    return {
      port: live.port,
      token: live.token,
      url: gatewayWsUrl(live.port),
      warmed: true,
      runtime: live.runtime,
    };
  }

  if (live) {
    await stopTenantGateway(tenantId);
  }

  const failedAt = lastFailAt.get(tenantId) || 0;
  if (Date.now() - failedAt < WARM_FAIL_COOLDOWN_MS) {
    const left = Math.ceil((WARM_FAIL_COOLDOWN_MS - (Date.now() - failedAt)) / 1000);
    throw new Error(
      `Warm gateway cooling down after failure (${left}s left) — using local this turn`,
    );
  }

  const admission = await admitTenant(tenantId);
  if (!admission.admitted) throw new HostCapacityExceededError(maxWarmTenants());

  let resolveStarting;
  let rejectStarting;
  const starting = new Promise((resolve, reject) => {
    resolveStarting = resolve;
    rejectStarting = reject;
  });
  starting.catch(() => { });

  pool.set(tenantId, {
    child: null,
    containerName: null,
    runtime: effectiveOpenclawRuntime(),
    port: 0,
    token: '',
    startedAt: Date.now(),
    lastUserRequestAt: 0,
    idleTimer: null,
    generation: nextGeneration(tenantId),
    inFlight: 0,
    starting,
  });

  try {
    const preferred = tenantGatewayPort(tenantId);
    let port;
    let token;
    let child = null;
    let containerName = null;
    let warmed = false;

    if (effectiveOpenclawRuntime() === 'docker') {
      const started = await startDockerGateway({
        tenantId,
        preferredPort: preferred,
      });
      port = started.port;
      token = started.token;
      containerName = started.containerName;
      warmed = Boolean(started.warmed);
    } else {
      port = await findFreePort(preferred);
      token = crypto.randomBytes(24).toString('hex');
      console.log(`[openclaw-gw] tenant ${tenantId}: starting warm gateway on ${port}`);
      child = await spawnGateway({
        tenantId,
        port,
        token,
        env: runCtx.env || {},
      });
    }

    const entry = {
      child,
      containerName,
      runtime: effectiveOpenclawRuntime(),
      port,
      token,
      startedAt: Date.now(),
      lastUserRequestAt: 0,
      idleTimer: null,
      generation: nextGeneration(tenantId),
      inFlight: 0,
      starting: null,
    };
    pool.set(tenantId, entry);
    superviseTenant(tenantId);
    lastFailAt.delete(tenantId);
    resolveStarting(entry);
    console.log(
      `[openclaw-gw] tenant ${tenantId}: warm gateway ready on ${port} runtime=${effectiveOpenclawRuntime()}`,
    );
    return {
      port,
      token,
      url: gatewayWsUrl(port),
      warmed,
      runtime: effectiveOpenclawRuntime(),
    };
  } catch (err) {
    lastFailAt.set(tenantId, Date.now());
    const cur = pool.get(tenantId);
    if (cur?.child?.pid) await killProcessTree(cur.child.pid);
    if (cur?.containerName) await dockerStopContainer(cur.containerName).catch(() => { });
    pool.delete(tenantId);
    rejectStarting(err);
    throw err;
  }
}

export async function stopTenantGateway(tenantId) {
  unsuperviseTenant(tenantId);
  const entry = pool.get(tenantId);
  if (!entry) {
    if (effectiveOpenclawRuntime() === 'docker') {
      await dockerStopContainer(dockerContainerName(tenantId)).catch(() => { });
    }
    await clearTenantComposioRuntime(tenantId);
    return;
  }
  pool.delete(tenantId);
  if (entry.runtime === 'docker' || entry.containerName) {
    const name = entry.containerName || dockerContainerName(tenantId);
    console.log(`[openclaw-gw] tenant ${tenantId}: docker stop ${name}`);
    await dockerStopContainer(name);
  } else if (entry.child?.pid) {
    await killProcessTree(entry.child.pid);
  }
  await clearTenantComposioRuntime(tenantId);
}

export async function recycleTenantGateway(tenantId) {
  await stopTenantGateway(tenantId);
  if (effectiveOpenclawRuntime() === 'docker') {
    const name = dockerContainerName(tenantId);
    console.log(`[openclaw-gw] tenant ${tenantId}: recycle remove ${name}`);
    await dockerRemoveContainer(name).catch(() => { });
  }
}

export async function stopAllTenantGateways() {
  const ids = [...pool.keys()];
  await Promise.all(ids.map((id) => stopTenantGateway(id)));
}

export function warmGatewayStats() {
  const out = {};
  for (const [id, entry] of pool.entries()) {
    out[id] = {
      port: entry.port,
      startedAt: entry.startedAt,
      generation: entry.generation,
      inFlight: entry.inFlight,
      pid: entry.child?.pid || null,
      container: entry.containerName || null,
      runtime: entry.runtime,
      starting: Boolean(entry.starting),
    };
  }
  return out;
}

process.once('exit', () => {
  for (const entry of pool.values()) {
    try {
      if (entry.child?.pid) {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], () => { });
        } else {
          entry.child.kill('SIGTERM');
        }
      }
    } catch {
      // ignore
    }
  }
});

// Re-export for tests / ops cleanup
export { dockerRemoveContainer, dockerContainerName };

const SUPERVISE_INTERVAL_MS = Number(process.env.ROCKY_OPENCLAW_SUPERVISE_MS || 15_000);
let superviseTimer = null;

/** Tenants the supervisor keeps up. Separate from `pool`, which only holds
 *  entries that are currently started. */
const supervised = new Set();

export function superviseTenant(tenantId) {
  supervised.add(tenantId);
}

export function unsuperviseTenant(tenantId) {
  supervised.delete(tenantId);
}

/**
 * One supervision sweep. Exported for tests so the behaviour can be asserted
 * without waiting on a timer.
 */
export async function superviseOnce(deps = {}) {
  const start = deps.start || startTenantGatewayById;
  const state = deps.containerState || dockerContainerState;
  const restarted = [];

  for (const tenantId of [...supervised]) {
    const entry = pool.get(tenantId);
    try {
      if (!entry) {
        await start(tenantId);
        restarted.push(tenantId);
        continue;
      }
      if (entry.runtime === 'docker' && entry.containerName) {
        const st = await state(entry.containerName);
        if (st !== 'running') {
          console.warn(
            `[openclaw-gw] tenant ${tenantId}: container ${st} — host restarting (generation bumps)`,
          );
          pool.delete(tenantId);
          await start(tenantId);
          restarted.push(tenantId);
        }
      } else if (entry.runtime === 'spawn' && entry.child && entry.child.exitCode !== null) {
        pool.delete(tenantId);
        await start(tenantId);
        restarted.push(tenantId);
      }
    } catch (err) {
      console.error(`[openclaw-gw] supervision failed for ${tenantId}:`, err?.message || err);
    }
  }
  return restarted;
}

export async function startTenantGatewayById(tenantId) {
  const [{ loadTenant }, { resolveOpenclawRunContext }] = await Promise.all([
    import('../tenants.mjs'),
    import('./tenant-openclaw.mjs'),
  ]);
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Cannot start gateway for unknown tenant ${tenantId}`);
  const ctx = await resolveOpenclawRunContext(tenant);
  return ensureTenantGateway(tenant, ctx);
}

export function startGatewaySupervisor() {
  if (superviseTimer) return;
  superviseTimer = setInterval(() => {
    superviseOnce().catch((err) =>
      console.error('[openclaw-gw] supervision sweep failed:', err?.message || err),
    );
  }, SUPERVISE_INTERVAL_MS);
  if (typeof superviseTimer.unref === 'function') superviseTimer.unref();
}

export function stopGatewaySupervisor() {
  if (superviseTimer) clearInterval(superviseTimer);
  superviseTimer = null;
}

export async function adoptRunningContainer(tenantId, containerName) {
  if (pool.has(tenantId)) return 'already-pooled';
  const meta = await readGatewayMeta(tenantId);
  if (!meta?.port || !meta?.token || !(await portListening(meta.port))) {
    console.warn(`[openclaw-gw] ${tenantId}: unreachable container ${containerName} — removing`);
    await dockerStopContainer(containerName).catch(() => { });
    await dockerRemoveContainer(containerName).catch(() => { });
    return 'removed';
  }
  const startedAt = Date.now();
  seedGeneration(tenantId, meta.generation);
  superviseTenant(tenantId);
  pool.set(tenantId, {
    child: null,
    containerName,
    runtime: 'docker',
    port: meta.port,
    token: meta.token,
    generation: nextGeneration(tenantId),
    inFlight: 0,
    startedAt,
    lastUserRequestAt: startedAt,
    idleTimer: null,
  });
  scheduleIdleStop(tenantId);
  console.log(`[openclaw-gw] ${tenantId}: adopted running container ${containerName} on ${meta.port}`);
  return 'adopted';
}

export async function reconcileContainers(knownTenantIds, deps = {}) {
  const list = deps.list || listRockyContainers;
  const stop = deps.stop || dockerStopContainer;
  const remove = deps.remove || dockerRemoveContainer;
  const adopt = deps.adopt || adoptRunningContainer;
  const known = new Set(knownTenantIds);
  const existing = await list();

  if (known.size === 0 && existing.length > 0) {
    console.error(
      `[openclaw-gw] REFUSING to reconcile: ${existing.length} container(s) exist but no tenants ` +
      `are known. Tenant root is probably wrong (ROCKY_TENANTS_DIR) or not yet mounted. ` +
      'No container was stopped.',
    );
    return [];
  }

  const orphans = [];

  for (const name of existing) {
    const tenantId = tenantIdFromContainerName(name);
    if (!tenantId) continue;
    if (known.has(tenantId)) {
      await adopt(tenantId, name);
      continue;
    }
    orphans.push(name);
    console.warn(`[openclaw-gw] orphan container ${name} belongs to no known tenant — stopping`);
    try {
      await stop(name);
      await remove(name);
    } catch (err) {
      console.error(`[openclaw-gw] could not remove orphan ${name}:`, err?.message || err);
    }
  }
  return orphans;
}
