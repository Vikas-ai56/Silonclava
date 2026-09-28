import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tenantClaudeConfigDir } from '../cli-home.mjs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_MODEL,
  OPENCLAW_VERSION,
  CODEX_MODEL,
  OPENCLAW_BIN,
  OPENCLAW_TIMEOUT_SEC,
  OPENCLAW_RUNTIME,
  effectiveOpenclawRuntime,
  canUseHostCliFallback,
  sessionIdleTtlFor,
  SESSION_RESET_IDLE_MINUTES,
  OPENCLAW_LOG_MAX_BYTES,
} from '../config.mjs';
import { cronWebhookToken } from '../cron-ingress.mjs';
import { tenantDir } from '../tenants.mjs';
import { ORG_DIR } from '../paths.mjs';
import { CONTAINER_SYNCED_SKILLS, CONTAINER_ORG_DIR, CONTAINER_STATE_DIR } from './container-paths.mjs';
import { sessionUserFor } from '../tenant-session.mjs';
import { withFileLock } from '../file-lock.mjs';
import {
  ensureTenantCliHome,
  tenantCliEnv,
} from '../cli-home.mjs';
import {
  claudeCredentialPresentSync,
  claudeReady,
  codexCredentialPresentSync,
  codexLoginHelp,
  codexReady,
  legacyCodexEnv,
  stripAnthropicStaticEnv,
} from '../tenant-cli/runtime-credentials.mjs';
import { createTenantClient, createTenantRuntimeClient } from '../tenant-cli/client.mjs';
import {
  ensureTenantGateway,
  isOpenclawWarmEnabled,
  tenantGatewayPort,
} from './tenant-gateway.mjs';

// Sonnet 5: tool and skill invocation degrade first on a small model.
// A slow turn is not a broken login.
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.ROCKY_FIRST_BYTE_TIMEOUT_MS || 150_000);

class FirstByteTimeout extends Error {
  constructor(ms) {
    super(`No model output within ${ms}ms`);
    this.name = 'FirstByteTimeout';
  }
}

const DEFAULT_CLAUDE_MODEL = 'anthropic/claude-sonnet-5';
// Key verified against `openclaw config schema` before writing it (P12).
const DEFAULT_THINKING = process.env.ROCKY_CLAUDE_THINKING || 'high';

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

export function resolveSyncedSkillDirs(tenantId) {
  const hostBase = path.join(tenantClaudeConfigDir(tenantId), 'skills', 'synced');
  const containerBase =
    effectiveOpenclawRuntime() === 'docker'
      ? CONTAINER_SYNCED_SKILLS
      : toPosix(hostBase);
  try {
    return fs
      .readdirSync(hostBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => `${containerBase}/${e.name}`);
  } catch {
    return [];
  }
}

export function tenantOpenclawStateDir(tenantId) {
  return path.join(tenantDir(tenantId), 'openclaw');
}

export function tenantOpenclawConfigPath(tenantId) {
  return path.join(tenantOpenclawStateDir(tenantId), 'openclaw.json');
}

function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d ? `+${d}` : null;
}

function pickModel(tenant) {
  const plan = String(tenant.plan || 'claude').toLowerCase();
  if (plan === 'codex') {
    const primary = CODEX_MODEL.includes('/') ? CODEX_MODEL : `openai/${CODEX_MODEL}`;
    return { primary, runtimeId: 'codex', plan: 'codex' };
  }
  const primary = CLAUDE_MODEL
    ? CLAUDE_MODEL.includes('/')
      ? CLAUDE_MODEL
      : `anthropic/${CLAUDE_MODEL}`
    : DEFAULT_CLAUDE_MODEL;
  return { primary, runtimeId: 'claude-cli', plan: 'claude' };
}

/**
 * Build / refresh per-tenant OpenClaw config under tenants/<id>/openclaw/.
 */
async function ensureTenantOpenclawUnlocked(tenant) {
  const stateDir = tenantOpenclawStateDir(tenant.id);
  const configPath = tenantOpenclawConfigPath(tenant.id);
  // Always derived. A cached absolute path in the tenant record survives a
  // deploy-path move and then points at a directory that no longer exists.
  const workspace = toPosix(path.join(tenantDir(tenant.id), 'workspace'));
  const gwPort = tenantGatewayPort(tenant.id);

  await fsPromises.mkdir(stateDir, { recursive: true });
  await ensureTenantCliHome(tenant);

  let existing = {};
  try {
    existing = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
  } catch {
    // first write
  }

  const { primary, runtimeId } = pickModel(tenant);
  const orgRoot = effectiveOpenclawRuntime() === 'docker' ? CONTAINER_ORG_DIR : toPosix(ORG_DIR);
  const syncedSkillDirs = resolveSyncedSkillDirs(tenant.id);
  const next = {
    ...existing,
    agents: {
      ...(existing.agents || {}),
      defaults: {
        ...((existing.agents && existing.agents.defaults) || {}),
        workspace,
        model: { primary },
        thinkingDefault: DEFAULT_THINKING,
        models: {
          [primary]: {
            agentRuntime: { id: runtimeId },
          },
        },
      },
    },
    logging: {
      ...((existing && existing.logging) || {}),
      file: `${CONTAINER_STATE_DIR}/logs/gateway.log`,
      maxFileBytes: OPENCLAW_LOG_MAX_BYTES,
      redactSensitive: 'tools',
    },
    session: {
      ...((existing && existing.session) || {}),
      dmScope: 'per-channel-peer',
      reset: { mode: 'idle', idleMinutes: SESSION_RESET_IDLE_MINUTES },
    },
    // NOTE: `cron.skipMissedJobs` was set here and is REMOVED. the pinned OpenClaw
    // has no such key and its config schema is strict, so the generated config
    // failed `openclaw config validate` and every tenant container refused to
    // start. Verified against the pinned image 2026-09-18. The missed-cron
    // decision is unresolved — see DECISIONS.md and backlog BL-006. Do not
    // re-add an option without validating it against the pinned image first.
    cron: {
      ...((existing && existing.cron) || {}),
      ...(cronWebhookToken() ? { webhookToken: cronWebhookToken() } : {}),
    },
    gateway: {
      ...((existing && existing.gateway) || {}),
      mode: 'local',
      bind: 'loopback',
      port: gwPort,
      http: {
        endpoints: {
          responses: { enabled: true },
        },
      },
    },
    skills: {
      ...(existing.skills || {}),
      load: {
        ...((existing.skills && existing.skills.load) || {}),
        extraDirs: [`${orgRoot}/skills`, ...syncedSkillDirs],
        allowSymlinkTargets: [orgRoot],
      },
    },
    mcp: {
      ...(existing.mcp || {}),
      sessionIdleTtlMs: sessionIdleTtlFor(tenant),
    },
  };

  // Strip keys that this OpenClaw version rejects.
  if (next.agents?.defaults) {
    delete next.agents.defaults.compaction;
    delete next.agents.defaults.thinking;
  }

  // WhatsApp must stay on Rocky Baileys only — never inside tenant OpenClaw.
  // A configured whatsapp plugin that fails to install makes `gateway run` exit and
  // warm mode falls back to cold `agent --local` every turn.
  if (next.channels && typeof next.channels === 'object') {
    const channels = { ...next.channels };
    let stripped = false;
    for (const key of Object.keys(channels)) {
      if (/whatsapp|baileys|kapso/i.test(key)) {
        delete channels[key];
        stripped = true;
      }
    }
    if (stripped) {
      console.warn(
        `[openclaw] tenant ${tenant.id}: stripped WhatsApp channels from openclaw.json (Baileys owns WhatsApp)`,
      );
    }
    next.channels = channels;
  }

  const prevPlugins = next.plugins && typeof next.plugins === 'object' ? next.plugins : {};
  const prevEntries = prevPlugins.entries;
  let entriesOut = {};
  if (Array.isArray(prevEntries)) {
    for (const e of prevEntries) {
      const id = String(e?.id || e || '');
      if (/whatsapp|baileys|kapso/i.test(id)) continue;
      entriesOut[id || String(e)] = typeof e === 'object' ? { ...e, enabled: e.enabled !== false } : { enabled: true };
    }
  } else if (prevEntries && typeof prevEntries === 'object') {
    for (const [id, val] of Object.entries(prevEntries)) {
      if (/whatsapp|baileys|kapso/i.test(id)) continue;
      entriesOut[id] = val;
    }
  }
  next.plugins = {
    ...prevPlugins,
    entries: entriesOut,
  };
  if (Array.isArray(next.plugins?.allow)) {
    next.plugins.allow = next.plugins.allow.filter((id) => !/whatsapp|baileys|kapso/i.test(String(id)));
  }
  if (Array.isArray(next.plugins?.load?.paths)) {
    next.plugins.load = {
      ...next.plugins.load,
      paths: next.plugins.load.paths.filter((p) => !/whatsapp|baileys|kapso/i.test(String(p))),
    };
  }

  // mcp.servers and OpenClaw's mcp-oauth directory are native OpenClaw state.
  // Preserve them exactly; only `openclaw mcp ...` may manage those values.
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsPromises.rename(tempPath, configPath);

  tenant.openclawStateDir = stateDir;
  tenant.openclawConfigPath = configPath;

  return { stateDir, configPath, workspace, config: next, gatewayPort: gwPort };
}

export function tenantOpenclawConfigLockPath(tenantId) {
  return `${tenantOpenclawConfigPath(tenantId)}.lock`;
}

export function withTenantOpenclawConfigLock(tenantId, operation, options) {
  return withFileLock(tenantOpenclawConfigLockPath(tenantId), operation, options);
}

export function ensureTenantOpenclaw(tenant) {
  return withTenantOpenclawConfigLock(tenant.id, () => ensureTenantOpenclawUnlocked(tenant));
}

export function stripNoReplySentinel(reply) {
  const text = String(reply ?? '').trim();
  return /^NO[_\s-]?REPLY[.!]?$/i.test(text) ? '' : text;
}

function extractReply(json) {
  if (!json || typeof json !== 'object') return null;

  // Gateway `openclaw agent --json` wraps the reply inside `result`.
  const inner = json.result && typeof json.result === 'object' ? json.result : json;

  // Top-level or inner `final` (agent exec / gateway envelope).
  if (typeof inner.final === 'string' && inner.final.trim()) return inner.final.trim();
  if (typeof json.final === 'string' && json.final.trim()) return json.final.trim();

  // meta.finalAssistantVisibleText (legacy / --local format).
  const meta = inner.meta || json.meta;
  if (typeof meta?.finalAssistantVisibleText === 'string') {
    const t = meta.finalAssistantVisibleText.trim();
    if (t) return t;
  }

  // payloads[].text — check inner (gateway) then top-level (exec/local).
  for (const src of [inner, json]) {
    const payloads = Array.isArray(src.payloads) ? src.payloads : [];
    const texts = payloads
      .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
      .filter(Boolean);
    if (texts.length) return texts.join('\n\n');
  }

  // Gateway summary fallback.
  if (typeof json.summary === 'string' && json.summary.trim()) return json.summary.trim();
  return null;
}

function parseOpenclawJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // 1. Try the entire stdout as a single JSON object (gateway envelope).
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch {
    // not a single JSON — fall through to line-by-line / heuristic.
  }

  // 2. JSONL: try each line, return the first that carries a reply.
  for (const line of text.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      if (extractReply(obj)) return obj;
    } catch {
      // skip malformed line
    }
  }

  // 3. Marker heuristic (legacy --local output that may have non-JSON preamble).
  const markers = ['"final":', '"finalAssistantVisibleText"', '"payloads"'];
  for (const marker of markers) {
    const idx = text.lastIndexOf(marker);
    if (idx < 0) continue;
    const start = text.lastIndexOf('{', idx);
    if (start < 0) continue;
    const tail = text.slice(start);
    const endRel = tail.lastIndexOf('}');
    if (endRel < 0) continue;
    try {
      const obj = JSON.parse(tail.slice(0, endRel + 1));
      if (extractReply(obj) || obj?.meta || obj?.payloads || obj?.result) return obj;
    } catch {
      // fall through
    }
  }

  // 4. Last JSON object on its own line.
  const start = text.lastIndexOf('\n{');
  const abs = start >= 0 ? start + 1 : text.lastIndexOf('{');
  if (abs < 0) return null;
  try {
    return JSON.parse(text.slice(abs));
  } catch {
    return null;
  }
}

let spawnVersionChecked = null;

export function assertPinnedSpawnRuntime({ force = false } = {}) {
  if (spawnVersionChecked !== null && !force) return spawnVersionChecked;
  const { command, argsPrefix } = resolveOpenclawSpawn();
  let found = null;
  try {
    const out = spawnSync(command, [...argsPrefix, '--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      shell: process.platform === 'win32',
    });
    found = String(`${out.stdout || ''}${out.stderr || ''}`).match(/\b(\d{4}\.\d+\.[\w.-]+)\b/)?.[1] || null;
  } catch {
    found = null;
  }

  const ok = found === OPENCLAW_VERSION;
  spawnVersionChecked = { ok, found, expected: OPENCLAW_VERSION };
  if (ok) return spawnVersionChecked;

  const message =
    `Spawn runtime is OpenClaw ${found || '<unknown>'} but the pin is ${OPENCLAW_VERSION}. ` +
    'Set ROCKY_OPENCLAW_BIN to the pinned build, or ROCKY_ALLOW_UNPINNED_OPENCLAW=1 to override.';
  if (String(process.env.ROCKY_ALLOW_UNPINNED_OPENCLAW || '') === '1') {
    console.warn(`[openclaw] WARNING: ${message}`);
    return spawnVersionChecked;
  }
  throw new Error(message);
}

export function resolveOpenclawSpawn() {
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

function runOpenclawAgent({
  stateDir,
  configPath,
  workspace,
  messageFile,
  to,
  timeoutSec,
  cliEnv,
  local = true,
  gateway = null,
}) {
  return new Promise((resolve, reject) => {
    // Fail closed before spawning an unpinned runtime.
    assertPinnedSpawnRuntime();
    const { command, argsPrefix, useShell } = resolveOpenclawSpawn();
    const args = [
      ...argsPrefix,
      'agent',
      ...(local ? ['--local'] : []),
      '--agent',
      'main',
      '--json',
      '--thinking',
      'off',
      '--timeout',
      String(timeoutSec),
      '--message-file',
      messageFile,
    ];
    if (to) args.push('--to', to);

    const env = stripAnthropicStaticEnv({
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_HOME: stateDir,
      ...cliEnv,
    });

    if (gateway) {
      env.OPENCLAW_GATEWAY_URL = gateway.url;
      env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
      env.OPENCLAW_GATEWAY_TOKEN = gateway.token;
    }

    const child = spawn(command, args, {
      cwd: workspace,
      env,
      shell: Boolean(useShell),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const hardMs = (timeoutSec + 15) * 1000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`OpenClaw timed out after ${timeoutSec}s`));
    }, hardMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      const parsed = parseOpenclawJson(stdout) || parseOpenclawJson(combined);
      const reply = extractReply(parsed);
      if (reply) {
        resolve({ reply, raw: parsed, stderr, authEpoch: /auth-epoch/i.test(stderr) });
        return;
      }

      const errMsg =
        (typeof parsed?.error === 'string' && parsed.error) ||
        stderr.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(' | ') ||
        stdout.trim().slice(-400) ||
        `OpenClaw exited ${code}`;
      const err = new Error(errMsg);
      err.authEpoch = /auth-epoch/i.test(stderr) || /auth-epoch/i.test(errMsg);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function assertCliReady(tenant) {
  const hostFallback = canUseHostCliFallback(tenant);
  const plan = String(tenant.plan || 'claude').toLowerCase();
  if (plan === 'codex') {
    if ((await codexReady(tenant.id)) || hostFallback) {
      return null;
    }
    return codexLoginHelp();
  }
  if ((await claudeReady(tenant.id)) || hostFallback) {
    return null;
  }
  const client = createTenantClient({
    tenantId: tenant.id,
    principal: `runtime:${tenant.id}`,
  });
  const login = await client.auth('claude').login({ replyJid: tenant.jid });
  return login.result.message;
}

/** Prefer tenant CLI home; omit overrides when falling back to host auth (dev). */
const _hostFallbackLogged = new Set();

export function buildSpawnCliEnv(tenant) {
  const plan = String(tenant.plan || 'claude').toLowerCase();
  const base = tenantCliEnv(tenant);
  const env = {};

  const hostFallback = canUseHostCliFallback(tenant);

  if (plan === 'codex') {
    if (codexCredentialPresentSync(tenant.id)) {
      env.CODEX_HOME = base.CODEX_HOME;
    } else if (hostFallback) {
      if (!_hostFallbackLogged.has(`codex:${tenant.id}`)) {
        _hostFallbackLogged.add(`codex:${tenant.id}`);
        console.warn(
          `[openclaw] tenant ${tenant.id}: using host Codex login (dev operator fallback; tenant cli-home not logged in)`,
        );
      }
    }
  } else if (claudeCredentialPresentSync(tenant.id)) {
    env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  } else if (hostFallback) {
    if (!_hostFallbackLogged.has(`claude:${tenant.id}`)) {
      _hostFallbackLogged.add(`claude:${tenant.id}`);
      console.warn(
        `[openclaw] tenant ${tenant.id}: using host Claude login (dev operator fallback; tenant cli-home not logged in)`,
      );
    }
  }

  return env;
}

/** Claude reads only its tenant CLI home; legacy Codex may still use its API-key env. */
export async function buildTenantLlmEnv(tenant) {
  const base = tenantCliEnv(tenant);
  const plan = String(tenant.plan || 'claude').toLowerCase();
  const env = {
    ...buildSpawnCliEnv(tenant),
    ...(plan === 'codex' ? await legacyCodexEnv(tenant.id) : {}),
  };
  if (env.OPENAI_API_KEY) {
    env.CODEX_HOME = base.CODEX_HOME;
  }
  return env;
}

/**
 * Paths + env OpenClaw would get for this tenant on a WhatsApp turn.
 * Used by the runner and by isolation tests.
 */
export async function resolveOpenclawRunContext(tenant) {
  const { stateDir, configPath: canonicalConfigPath, workspace, config, gatewayPort } =
    await ensureTenantOpenclaw(tenant);
  const hydrated = await createTenantRuntimeClient({ tenantId: tenant.id })
    .hydrateMcp(canonicalConfigPath);
  const runtime = hydrated.result;
  const configPath = runtime.configPath;
  const cliEnv = await buildTenantLlmEnv(tenant);
  return {
    stateDir,
    configPath,
    canonicalConfigPath,
    mcpProjectionPath: runtime.projectionPath,
    workspace,
    config,
    gatewayPort,
    cliEnv,
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_HOME: stateDir,
      ...cliEnv,
    },
  };
}

/**
 * Direct HTTP turn via the warm gateway — SSE streaming.
 * Text chunks arrive during the Claude turn (before the 5s post-processing gap),
 * so we collect them from the stream and return as soon as 'response.completed'
 * or the stream closes — whichever comes first.
 */
async function runGatewayHttpTurn({ port, token, message, to, timeoutSec, sessionUser }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 5) * 1000);

  try {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        // OpenClaw 2026.3.28+ requires operator scopes on HTTP bearer calls.
        'x-openclaw-scopes': 'operator.read,operator.write,operator.admin',
        'x-openclaw-agent-id': 'main',
        ...(to ? { 'x-openclaw-message-to': to } : {}),
      },
      body: JSON.stringify({
        model: 'openclaw',
        input: String(message).trim(),
        stream: true,
        user: sessionUser || `rocky-${to || 'default'}`,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`/v1/responses HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    // If the server ignored stream:true and returned JSON, handle that.
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const json = await res.json();
      if (Array.isArray(json.output)) {
        const texts = [];
        for (const item of json.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
                texts.push(part.text.trim());
              }
            }
          }
        }
        if (texts.length) return { reply: texts.join('\n\n'), mode: 'http' };
      }
      const reply = extractReply(json);
      if (reply) return { reply, mode: 'http' };
      throw new Error(json.error?.message || 'No reply in /v1/responses JSON');
    }

    // SSE streaming, resolved on **terminal completion only** (SPEC-phase3c §2).
    //
    // This previously returned as soon as text deltas went quiet for 800ms,
    // which is ambiguous: a pause in the token stream is indistinguishable from
    // a finished response, so a slow tool call could be reported as a complete
    // answer and committed as the turn's result. `response.completed` costs a
    // few seconds of gateway post-processing and is the only signal that the
    // model actually finished.
    const chunks = [];
    const decoder = new TextDecoder();
    let buf = '';

    const replyFromChunks = () => {
      const reply = chunks.join('').trim();
      console.log(`[openclaw] SSE returning at +${Date.now() - t0}ms (${chunks.length} chunks, ${reply.length} chars)`);
      return reply;
    };

    // Process the stream to terminal completion.
    const streamPromise = (async () => {
      for await (const raw of res.body) {
        buf += decoder.decode(raw, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return 'done';
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'response.output_text.delta' && evt.delta) {
              if (!chunks.length) console.log(`[openclaw] SSE first delta at +${Date.now() - t0}ms`);
              chunks.push(evt.delta);
            }
            if (evt.type === 'response.output_text.done' && evt.text) {
              chunks.length = 0;
              chunks.push(evt.text);
              return 'text-done';
            }
            if (evt.type === 'response.completed') return 'completed';
            // Fail fast on auth / model errors instead of hanging until AbortController.
            const errMsg =
              evt.error?.message ||
              evt.message ||
              evt.response?.error?.message ||
              (evt.type && String(evt.type).includes('error') ? JSON.stringify(evt).slice(0, 240) : null);
            if (
              errMsg &&
              (/not logged in|please run \/login|unauthorized|invalid.?api.?key|failover|FailoverError/i.test(
                errMsg,
              ) ||
                evt.type === 'error' ||
                evt.type === 'response.failed')
            ) {
              throw new Error(errMsg);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
      return 'stream-end';
    })();

    // Also fail if no deltas arrive within a short window (auth failures often hang the SSE).
    const firstByteMs = Math.min(FIRST_BYTE_TIMEOUT_MS, (timeoutSec + 5) * 1000);
    const firstBytePromise = new Promise((_, reject) => {
      const t = setTimeout(() => {
        if (!chunks.length) {
          reject(new FirstByteTimeout(firstByteMs));
        }
      }, firstByteMs);
      if (typeof t.unref === 'function') t.unref();
    });

    // Terminal completion or a hard failure — never a quiet-stream guess.
    // The first-byte timeout still applies, because an unauthorized gateway
    // hangs the stream without ever producing a delta.
    try {
      await Promise.race([streamPromise, firstBytePromise]);
    } catch (err) {
      ctrl.abort();
      throw err;
    }

    const reply = replyFromChunks();
    if (reply) return { reply, mode: 'http-stream' };

    throw new Error('SSE stream ended without text');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One WhatsApp turn through this tenant's project-local OpenClaw (Claude or Codex).
 * Priority: HTTP to warm gateway → CLI to warm gateway → cold --local.
 */
export async function runOpenclawTurn(tenant, text) {
  const started = Date.now();
  const to = e164(tenant.phone);
  const ctx = await resolveOpenclawRunContext(tenant);
  const { stateDir, configPath, workspace, cliEnv } = ctx;

  const loginMsg = await assertCliReady(tenant);
  if (loginMsg) return loginMsg;

  let mode = 'local';
  {
    if (isOpenclawWarmEnabled()) {
      try {
        const gateway = await ensureTenantGateway(tenant, ctx);
        mode = gateway.warmed ? 'warm' : 'cold-start-warm';

        // Fast path: direct HTTP to the warm gateway (no CLI spawn).
        try {
          const { reply, mode: httpMode } = await runGatewayHttpTurn({
            port: gateway.port,
            token: gateway.token,
            message: text,
            to,
            timeoutSec: OPENCLAW_TIMEOUT_SEC,
            sessionUser: sessionUserFor(tenant, to),
          });
          console.log(
            `[openclaw] tenant ${tenant.id} turn ${Date.now() - started}ms (${mode}-${httpMode})`,
          );
          return stripNoReplySentinel(reply);
        } catch (httpErr) {
          const httpMsg = String(httpErr?.message || httpErr);
          console.warn(
            `[openclaw] tenant ${tenant.id}: HTTP turn failed:`,
            httpMsg,
          );
          if (/not logged in|please run \/login|unauthorized/i.test(httpMsg)) {
            return (
              'Claude isn’t authorized inside your workspace container.\n\n' +
              'Send: connect claude\n' +
              'Open the link, approve, then paste the code back here.'
            );
          }
          // Warm CLI path needs operator.write scopes this OpenClaw build rejects — skip it.
          throw httpErr;
        }
      } catch (warmErr) {
        const warmMsg = String(warmErr?.message || warmErr);
        console.warn(
          `[openclaw] tenant ${tenant.id}: warm gateway failed:`,
          warmMsg,
        );
        if (warmErr instanceof FirstByteTimeout) {
          return 'That one is taking longer than I can hold the line for. Send it again and I will pick it up.';
        }
        if (/not logged in|please run \/login|unauthorized/i.test(warmMsg)) {
          return (
            'Claude isn’t authorized inside your workspace container.\n\n' +
            'Send: connect claude\n' +
            'Open the link, approve, then paste the code back here.'
          );
        }
        // Docker runtime: don't hang on host --local (wrong paths / long timeouts).
        if (effectiveOpenclawRuntime() === 'docker') {
          // The diagnostic goes to the log, never to the user: container names,
          // ports and filesystem paths reached a WhatsApp thread this way.
          console.warn(`[openclaw] tenant ${tenant.id}: docker turn failed: ${warmMsg.slice(0, 300)}`);
          return 'I hit a temporary issue on my side. Give me a moment and try again.';
        }
        mode = 'local-fallback';
      }
    }

    if (mode !== 'local-fallback' && mode !== 'local') {
      return 'I hit a temporary issue reaching my model. Give me a moment and try again.';
    }

    // Cold --local fallback (spawn runtime only).
    const tmp = path.join(
      os.tmpdir(),
      `rocky-openclaw-${tenant.id}-${process.pid}-${Date.now()}.txt`,
    );
    await fsPromises.writeFile(tmp, String(text || '').trim(), 'utf8');
    // No in-turn retry (SPEC-phase3c §2, §6). A second attempt here would hide
    // the failure from the durable layer, bill a second model call, and make the
    // turn non-atomic — the first attempt may already have run tools. A failed
    // turn is re-executed in full from the original request by the scheduler,
    // which is the only place that knows whether the response was committed.
    try {
      const { reply } = await runOpenclawAgent({
        stateDir, configPath, workspace, cliEnv,
        messageFile: tmp,
        to,
        timeoutSec: OPENCLAW_TIMEOUT_SEC,
        local: true,
      });
      console.log(
        `[openclaw] tenant ${tenant.id} turn ${Date.now() - started}ms (${mode})`,
      );
      return stripNoReplySentinel(reply);
    } finally {
      await fsPromises.unlink(tmp).catch(() => { });
    }
  }
  return 'Something went wrong — no reply from the model.';
}
