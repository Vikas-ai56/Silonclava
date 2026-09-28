import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { loadLocalEnv } from './load-env.mjs';
import { validateVaultMasterKey } from './tenant-cli/vault-config.mjs';

loadLocalEnv();

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(digits)
    .filter((d) => d.length >= 8);
}

function loadFileConfig() {
  const file = path.join(ROOT, 'rocky.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const fileCfg = loadFileConfig();
// Prefer platform PORT (Railway/Fly/etc.), then ROCKY_PORT, then local default.
export const PORT = Number(process.env.PORT || process.env.ROCKY_PORT || 8787);

export const OPERATOR_PHONES = new Set([
  ...parseList(process.env.ROCKY_OPERATOR_PHONES),
  ...parseList((fileCfg.operatorPhones || []).join(',')),
]);

const ALLOW_FROM_RAW = String(
  process.env.ROCKY_ALLOW_FROM || process.env.ROCKY_ALLOWED_WHATSAPP_FROM || fileCfg.allowFrom || '',
).trim();

/**
 * Open access is an explicit setting, never the side effect of an unset
 * variable. An empty allowlist in prod is a misconfiguration and refuses to
 * boot; `ROCKY_ALLOW_FROM=*` is a deliberate decision that boots with a warning.
 */
export const ALLOW_ALL_PHONES = ALLOW_FROM_RAW === '*';

export const ALLOWED_PHONES = new Set(
  ALLOW_ALL_PHONES
    ? []
    : [
        ...parseList(ALLOW_FROM_RAW),
        ...parseList((fileCfg.allowFrom || fileCfg.allowedPhones || []).join(',')),
      ],
);

export const OPERATOR_NAME = process.env.ROCKY_OPERATOR_NAME || fileCfg.operatorName || 'Operator';
export const OPERATOR_PLAN = (process.env.ROCKY_OPERATOR_PLAN || fileCfg.operatorPlan || 'claude').toLowerCase();
export const CLAUDE_BIN = process.env.ROCKY_CLAUDE_BIN || fileCfg.claudeBin || 'claude';
export const CLAUDE_MODEL = process.env.ROCKY_CLAUDE_MODEL || fileCfg.claudeModel || '';
export const OPENCLAW_BIN = process.env.ROCKY_OPENCLAW_BIN || fileCfg.openclawBin || 'openclaw';
export const OPENCLAW_TIMEOUT_SEC = Number(
  process.env.ROCKY_OPENCLAW_TIMEOUT_SEC || fileCfg.openclawTimeoutSec || 150,
);
export const CODEX_MODEL = process.env.ROCKY_CODEX_MODEL || fileCfg.codexModel || 'openai/gpt-5.4';

export const OPENCLAW_WARM = !['0', 'false', 'no'].includes(
  String(process.env.ROCKY_OPENCLAW_WARM || fileCfg.openclawWarm || 'true').toLowerCase(),
);

export const OPENCLAW_RUNTIME = String(
  process.env.ROCKY_OPENCLAW_RUNTIME || fileCfg.openclawRuntime || 'spawn',
)
  .trim()
  .toLowerCase() === 'docker'
  ? 'docker'
  : 'spawn';

/**
 * The single source of truth for the pinned OpenClaw version.
 *
 * `Dockerfile.openclaw` (ARG) and the `docker:build:openclaw` script cannot
 * import this, so a test holds all three in agreement — the version used to
 * live in ten places, which is how an unvalidated cron option reached four
 * documents and the code without anyone checking it against the image.
 *
 * **Pinned to `2026.7.1-2` despite it being a semver prerelease.** The bump to
 * `2026.7.33` (the `extended-stable` tag) was reverted 2026-09-18: that release
 * is broken as published. It declares `@openclaw/ai@2026.7.33` in
 * `dependencies`, the package exists on npm and installs standalone, but
 * `npm install -g openclaw@2026.7.33` silently omits it — no warning, no
 * non-zero exit. The gateway then dies at startup with
 * `Cannot find package '@openclaw/ai'`. Reproduced on a clean `node:22` image.
 *
 * Do not move to 2026.9.x while npm tags `latest` and `beta` at the same
 * version. Before changing this, run a container to `[gateway] ready` — a
 * `config validate` pass does not exercise module resolution.
 */
export const OPENCLAW_VERSION = '2026.7.1-2';

export const OPENCLAW_DOCKER_IMAGE =
  process.env.ROCKY_OPENCLAW_IMAGE ||
  fileCfg.openclawImage ||
  `rocky-openclaw:${OPENCLAW_VERSION}`;


/**
 * Hibernate an idle tenant after 20 minutes. Two hours meant a handful of
 * one-message users held every warm slot for the rest of the morning, which is
 * the capacity problem BL-016 describes; a cold start costs ~24s once.
 */
export const OPENCLAW_GATEWAY_IDLE_MS = Number(
  process.env.ROCKY_OPENCLAW_GATEWAY_IDLE_MS ||
  fileCfg.openclawGatewayIdleMs ||
  20 * 60 * 1000,
);

/** Loopback port base for per-tenant OpenClaw Gateways (hash → base..base+899). */
export const OPENCLAW_GATEWAY_PORT_BASE = Number(
  process.env.ROCKY_OPENCLAW_GATEWAY_PORT_BASE || fileCfg.openclawGatewayPortBase || 19100,
);


export const MAX_TENANTS_PER_HOST = Number(
  process.env.ROCKY_MAX_TENANTS_PER_HOST ||
  process.env.ROCKY_OPENCLAW_MAX_WARM ||
  fileCfg.maxTenantsPerHost ||
  fileCfg.openclawMaxWarm ||
  5,
);

/**
 * Legacy compatibility flag. Rocky no longer terminates processes it does not own.
 */
export const OPENCLAW_KILL_FOREIGN = !['0', 'false', 'no'].includes(
  String(
    process.env.ROCKY_OPENCLAW_KILL_FOREIGN || fileCfg.openclawKillForeign || 'false',
  ).toLowerCase(),
);

/** Coalesce rapid WhatsApp texts into one OpenClaw turn (ms). */
export const INBOUND_COALESCE_MS = Number(
  process.env.ROCKY_INBOUND_COALESCE_MS || fileCfg.inboundCoalesceMs || 1500,
);

/** Send a short ack when user texts while a turn is already running. */
export const INBOUND_BUSY_ACK = !['0', 'false', 'no'].includes(
  String(process.env.ROCKY_INBOUND_BUSY_ACK || fileCfg.inboundBusyAck || 'true').toLowerCase(),
);

/** Optional Slack/Discord/generic webhook for Baileys logout. */
export const LOGOUT_WEBHOOK_URL =
  process.env.ROCKY_LOGOUT_WEBHOOK_URL || fileCfg.logoutWebhookUrl || '';

/** Admin Bearer token (captured at load — same as other security gates). */
export const API_TOKEN = String(
  process.env.ROCKY_API_TOKEN || fileCfg.apiToken || '',
).trim();

/** If true, allow host ~/.claude or ~/.codex when tenant cli-home has no login (dev only). */
export const CLI_HOST_FALLBACK = ['1', 'true', 'yes'].includes(
  String(process.env.ROCKY_CLI_HOST_FALLBACK || fileCfg.cliHostFallback || '').toLowerCase(),
);

export const ROCKY_PROFILE = (() => {
  const raw = String(
    process.env.ROCKY_PROFILE || fileCfg.profile || process.env.NODE_ENV || 'dev',
  )
    .trim()
    .toLowerCase();
  if (raw === 'prod' || raw === 'production') return 'prod';
  return 'dev';
})();

export const IS_PROD_PROFILE = ROCKY_PROFILE === 'prod';
const VAULT_MASTER_KEY_ERROR = validateVaultMasterKey();

function slugInstanceId(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'local';
}

function derivedInstanceId() {
  if (IS_PROD_PROFILE) return process.env.ROCKY_PUBLIC_BASE_URL || os.hostname();
  const root = process.env.ROCKY_TENANTS_DIR
    ? path.resolve(process.env.ROCKY_TENANTS_DIR)
    : path.join(ROOT, 'tenants');
  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `local-${digest}`;
}

export const ROCKY_INSTANCE_ID = slugInstanceId(
  process.env.ROCKY_INSTANCE_ID || fileCfg.instanceId || derivedInstanceId(),
);

/** Prod always uses docker; dev honors ROCKY_OPENCLAW_RUNTIME. */
export function effectiveOpenclawRuntime() {
  if (IS_PROD_PROFILE) return 'docker';
  return OPENCLAW_RUNTIME;
}

/** Host CLI login is dev-only and limited to operator tenants. */
export function canUseHostCliFallback(tenant) {
  if (IS_PROD_PROFILE || !CLI_HOST_FALLBACK) return false;
  if (tenant?.role === 'operator') return true;
  return isOperatorPhone(tenant?.phone || tenant?.id);
}

/** Web signup phone must pass inbound allowlist when prod or allowlist is configured. */
export function canSignupPhone(phoneOrJid) {
  if (ALLOW_ALL_PHONES) return true;
  if (ALLOWED_PHONES.size === 0) {
    return !IS_PROD_PROFILE;
  }
  return isAllowedPhone(phoneOrJid);
}

/**
 * Fail fast on prod misconfiguration. Dev logs warnings only.
 * @returns {string[]} fatal errors (non-empty → caller should exit)
 */
export function validateStartupSecurity({ channelKind = null } = {}) {
  const errors = [];
  const warnings = [];

  if (IS_PROD_PROFILE) {
    if (OPENCLAW_RUNTIME !== 'docker') {
      errors.push('ROCKY_PROFILE=prod requires ROCKY_OPENCLAW_RUNTIME=docker');
    }
    if (CLI_HOST_FALLBACK) {
      errors.push('ROCKY_PROFILE=prod forbids ROCKY_CLI_HOST_FALLBACK=1');
    }
    if (ALLOW_ALL_PHONES) {
      warnings.push(
        'ROCKY_ALLOW_FROM=* — every WhatsApp sender is admitted and a new sender auto-provisions ' +
          'a tenant. Each tenant needs its own Claude login before it can answer, and admission ' +
          'is still capped by ROCKY_MAX_TENANTS_PER_HOST.',
      );
    } else if (ALLOWED_PHONES.size === 0) {
      errors.push(
        'ROCKY_PROFILE=prod requires ROCKY_ALLOW_FROM — a comma-separated list, or "*" to admit everyone',
      );
    }
    if (!API_TOKEN) {
      errors.push('ROCKY_PROFILE=prod requires ROCKY_API_TOKEN');
    }
    if (VAULT_MASTER_KEY_ERROR) {
      errors.push(`ROCKY_PROFILE=prod requires a valid vault key: ${VAULT_MASTER_KEY_ERROR}`);
    }
    if (channelKind === 'mock') {
      errors.push('ROCKY_PROFILE=prod forbids the mock channel');
    }
    if (process.env.TWILIO_API_ROOT) {
      errors.push(
        'ROCKY_PROFILE=prod forbids TWILIO_API_ROOT — it is a test seam and would redirect ' +
          'every outbound message away from Twilio',
      );
    }
    if (channelKind === 'twilio' && !process.env.ROCKY_PUBLIC_BASE_URL) {
      errors.push(
        'ROCKY_PROFILE=prod with the twilio channel requires an explicit ROCKY_PUBLIC_BASE_URL — ' +
          'the loopback default would make every webhook signature fail',
      );
    }
    if (ROCKY_INSTANCE_ID === 'local') {
      warnings.push(
        'ROCKY_INSTANCE_ID=local on prod — set a unique id (e.g. sg1) so Docker names do not collide with laptops',
      );
    }
  } else {
    if (CLI_HOST_FALLBACK) {
      warnings.push(
        'ROCKY_CLI_HOST_FALLBACK=1 — only operator phones may use host Claude/Codex; customer tenants need cli-home OAuth',
      );
    }
    if (OPENCLAW_RUNTIME === 'docker') {
      warnings.push(
        `Docker dev instance "${ROCKY_INSTANCE_ID}" — containers are rocky-oc-${ROCKY_INSTANCE_ID}-<tenant> (prod uses a different instance id)`,
      );
    }
  }

  for (const w of warnings) console.warn(`[security] ${w}`);
  return errors;
}

/** Public base URL for OAuth redirects + WhatsApp links (ngrok in prod/dev phone tests). */
export const PUBLIC_BASE_URL = (
  process.env.ROCKY_PUBLIC_BASE_URL ||
  fileCfg.publicBaseUrl ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, '');

export const CONNECTOR_SIDECAR_URL = String(
  process.env.ROCKY_CONNECTOR_SIDECAR_URL ||
  fileCfg.connectorSidecarUrl ||
  'http://127.0.0.1:4317',
).replace(/\/$/, '');
export const ENTERPRISE_ORG_ID = String(
  process.env.ROCKY_ENTERPRISE_ORG_ID || fileCfg.enterpriseOrgId || 'buglerock',
).trim();
export const CONNECTOR_ASSERTION_ISSUER = 'rocky-connector-control-plane';
export const CONNECTOR_ASSERTION_AUDIENCE = 'irock-connector-sidecar';

/** Default tenant session idle (Claude/MCP warm). 3 hours. */
export const SESSION_IDLE_TTL_MS = Number(
  process.env.ROCKY_SESSION_IDLE_TTL_MS ||
  fileCfg.sessionIdleTtlMs ||
  3 * 60 * 60 * 1000,
);

/** Preserve direct-message session context across multi-day reply gaps. */
export const SESSION_RESET_IDLE_MINUTES = Number(
  process.env.ROCKY_SESSION_RESET_IDLE_MINUTES ||
  fileCfg.sessionResetIdleMinutes ||
  90 * 24 * 60,
);

/** Operator/dev warm TTL. 24 hours. */
export const OPERATOR_SESSION_IDLE_TTL_MS = Number(
  process.env.ROCKY_OPERATOR_SESSION_IDLE_TTL_MS ||
  fileCfg.operatorSessionIdleTtlMs ||
  24 * 60 * 60 * 1000,
);

export function sessionIdleTtlFor(tenant) {
  if (tenant?.role === 'operator' || isOperatorPhone(tenant?.phone || tenant?.id)) {
    return OPERATOR_SESSION_IDLE_TTL_MS;
  }
  return SESSION_IDLE_TTL_MS;
}

export function isOperatorPhone(phoneOrJid) {
  const d = digits(String(phoneOrJid || '').split('@')[0].split(':')[0]);
  if (!d) return false;
  if (OPERATOR_PHONES.has(d)) return true;
  for (const op of OPERATOR_PHONES) {
    if (d === op) return true;
  }
  return false;
}

/** When ALLOWED_PHONES is empty, everyone is allowed. Otherwise only listed phones. */
export function isAllowedPhone(phoneOrJid) {
  if (ALLOW_ALL_PHONES) return true;
  if (ALLOWED_PHONES.size === 0) return true;
  const d = digits(String(phoneOrJid || '').split('@')[0].split(':')[0]);
  if (!d) return false;
  if (ALLOWED_PHONES.has(d)) return true;
  for (const a of ALLOWED_PHONES) {
    if (d === a) return true;
    if (d.length >= 10 && a.length >= 10 && (d.endsWith(a) || a.endsWith(d))) return true;
  }
  return false;
}

export const SHUTDOWN_GRACE_MS = Number(process.env.ROCKY_SHUTDOWN_GRACE_MS || 20_000);

export const OPENCLAW_LOG_MAX_BYTES = Number(
  process.env.ROCKY_OPENCLAW_LOG_MAX_BYTES || fileCfg.openclawLogMaxBytes || 32 * 1024 * 1024,
);

export const CRON_WEBHOOK_URL =
  process.env.ROCKY_CRON_WEBHOOK_URL ||
  fileCfg.cronWebhookUrl ||
  (PUBLIC_BASE_URL && !/^https?:\/\/(127\.|localhost|0\.0\.0\.0|\[?::1)/i.test(PUBLIC_BASE_URL)
    ? `${String(PUBLIC_BASE_URL).replace(/\/+$/, '')}/internal/cron/delivery`
    : `http://host.docker.internal:${PORT}/internal/cron/delivery`);

export function blandApiKey() {
  return String(process.env.BLAND_API_KEY || '').trim();
}

export function blandWebhookSecret() {
  return String(process.env.BLAND_WEBHOOK_SECRET || '').trim();
}

export function blandSignatureRequired() {
  return String(process.env.BLAND_WEBHOOK_REQUIRE_SIGNATURE || 'true').trim().toLowerCase() !== 'false';
}

export function blandCallbackSecret() {
  return String(process.env.BLAND_CALLBACK_SECRET || '').trim();
}

export function blandWebhookUrlFor(callbackRef) {
  const base = PUBLIC_BASE_URL
    ? String(PUBLIC_BASE_URL).replace(/\/+$/, '')
    : `http://127.0.0.1:${PORT}`;
  return `${base}/webhooks/bland/${encodeURIComponent(callbackRef)}`;
}

export function cronWebhookUrlFor(tenantId) {
  const base = String(CRON_WEBHOOK_URL);
  const id = String(tenantId || '').trim();
  if (!id) throw new Error('cronWebhookUrlFor requires a tenant id');
  return `${base}${base.includes('?') ? '&' : '?'}t=${encodeURIComponent(id)}`;
}

export function cronWebhookReachable(url = CRON_WEBHOOK_URL) {
  try {
    const { hostname, protocol } = new URL(url);
    if (/^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (['localhost', '::1', 'host.docker.internal'].includes(hostname)) return false;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
