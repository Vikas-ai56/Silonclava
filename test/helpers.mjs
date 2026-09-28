import fs from 'node:fs/promises';
import path from 'node:path';
import { TENANTS_DIR } from '../src/paths.mjs';
import { createTenantClient } from '../src/tenant-cli/client.mjs';

export function tempTenantId(prefix = '1555') {
  return `${prefix}${String(process.pid).slice(-6)}${String(Date.now()).slice(-4)}`;
}

export async function rmTenant(id) {
  await fs.rm(path.join(TENANTS_DIR, id), { recursive: true, force: true });
}

export function tenantTestClient(tenantId) {
  return createTenantClient({
    tenantId,
    principal: `test:${tenantId}`,
  });
}

/** Run fn with mocked global fetch; restores after. */
export async function withMockFetch(handler, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input), init || {});
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

/**
 * Fresh config module with env applied during import (and optional `run`).
 * Env is always restored in finally — keep live process.env reads inside `run`.
 */
export async function importFreshConfig(extraEnv = {}, run) {
  const prev = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const url = new URL('../src/config.mjs', import.meta.url);
    url.searchParams.set('v', String(Date.now()) + Math.random());
    const mod = await import(url.href);
    if (typeof run === 'function') return await run(mod);
    return mod;
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
