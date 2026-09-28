import fs from 'node:fs/promises';
import path from 'node:path';
import { tenantDir } from '../tenants.mjs';

const SECRET_KEY = /token|secret|password|credential|authorization|authorize|api.?key|code|verifier|oauthState|pastePage|redirect|connectLink|headers|^endpoint$|endpointUrl|^(?:raw|input|paste|value)$/i;
const SENSITIVE_TEXT = /(?:access_token|refresh_token|client_secret|CODE#STATE|oauth\/authorize\?|accounts\.google\.com\/o\/oauth2|[?&]state=|sk-ant-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{12,}#[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_-]{40,}\b)/i;

export function redactParams(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && SENSITIVE_TEXT.test(value)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactParams(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactParams(child, childKey)]),
    );
  }
  return value;
}

export async function appendTenantAudit({ tenantId, actor, resource, action, params, result }) {
  if (!tenantId) return;
  const dir = tenantDir(tenantId);
  // Never create the tenant directory to hold a log line: a deprovision would
  // otherwise resurrect the directory it had just archived, 3ms after moving
  // it. A record about a tenant that no longer exists belongs in the platform
  // audit, which outlives them.
  const exists = await fs.stat(dir).then(() => true).catch(() => false);
  if (!exists) return;
  const file = path.join(dir, 'audit.jsonl');
  const row = {
    ts: new Date().toISOString(),
    actor: actor || 'operator',
    resource,
    action,
    params_redacted: redactParams(params || {}),
    result: redactParams(result || {}),
  };
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export async function appendPlatformAudit({ actor, resource, action, params, result }) {
  const { PLATFORM_DIR } = await import('../paths.mjs');
  const file = path.join(PLATFORM_DIR, 'audit.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = {
    ts: new Date().toISOString(),
    actor: actor || 'operator',
    resource,
    action,
    params_redacted: redactParams(params || {}),
    result: redactParams(result || {}),
  };
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
