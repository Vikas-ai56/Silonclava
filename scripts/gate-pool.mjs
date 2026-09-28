#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POOL = Number(process.env.GATE_POOL_SIZE || 5);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-gate-pool-'));

process.env.ROCKY_TENANTS_DIR = ROOT;
process.env.ROCKY_OPENCLAW_RUNTIME = 'docker';
process.env.ROCKY_MAX_TENANTS_PER_HOST = String(POOL);
delete process.env.ROCKY_INSTANCE_ID;

const results = [];
let failures = 0;

function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

async function docker(args, timeoutMs = 120_000) {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 4 << 20 });
    return String(stdout || '');
  } catch (err) {
    return String(err?.stdout || '') + String(err?.stderr || err?.message || '');
  }
}

async function containerState(name) {
  return (await docker(['inspect', '-f', '{{.State.Status}}', name])).trim();
}

async function waitReady(name, timeoutMs = 120_000) {
  const t0 = Date.now();
  const startedAtRaw = (await docker(['inspect', name, '--format', '{{.State.StartedAt}}'])).trim();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    const logs = await docker(['logs', '--since', startedAtRaw, name]);
    if (/\[gateway\] ready/.test(logs)) return { ok: true, ms: Date.now() - t0 };
    if (/Permission denied|Cannot find package|failed to start/i.test(logs)) {
      return { ok: false, ms: Date.now() - t0, error: logs.slice(-300) };
    }
    if ((await containerState(name)) === 'exited') {
      return { ok: false, ms: Date.now() - t0, error: `exited: ${logs.slice(-300)}` };
    }
  }
  return { ok: false, ms: Date.now() - t0, error: 'timeout' };
}

async function main() {
  console.log(`\nGATE POOL — ${POOL} concurrent tenants: start -> isolate -> hibernate -> wake\n`);
  console.log(`  tenants dir: ${ROOT}\n`);

  const cfg = await import('../src/config.mjs');
  const { signupFromWeb } = await import('../src/onboarding.mjs');
  const { normalizePhone } = await import('../src/phone.mjs');
  const gw = await import('../src/openclaw/tenant-gateway.mjs');
  const { dockerContainerName, DEFAULT_OPENCLAW_IMAGE } = await import('../src/openclaw/docker-gateway.mjs');

  console.log('Setup');
  if (!step('image present', (await docker(['images', '-q', DEFAULT_OPENCLAW_IMAGE])).trim().length > 0, DEFAULT_OPENCLAW_IMAGE)) return;
  step('ceiling configured', gw.maxWarmTenants() === POOL, `maxWarmTenants()=${gw.maxWarmTenants()}`);

  console.log('\nProvision');
  const tenants = [];
  for (let i = 0; i < POOL + 1; i += 1) {
    const phone = `9199000000${String(i).padStart(2, '0')}`;
    cfg.ALLOWED_PHONES.add(normalizePhone(phone).phone);
    const { tenant } = await signupFromWeb({ name: `Pool ${i}`, phone, plan: 'claude' });
    tenants.push(tenant.id);
    await fs.writeFile(path.join(ROOT, tenant.id, 'openclaw', 'marker.txt'), tenant.id, 'utf8');
  }
  step('provisioned tenants', tenants.length === POOL + 1, `${tenants.length} (${POOL} + 1 overflow)`);

  const pool = tenants.slice(0, POOL);
  const overflow = tenants[POOL];

  console.log('\nConcurrent cold start');
  const startT0 = Date.now();
  const started = await Promise.allSettled(pool.map((id) => gw.startTenantGatewayById(id)));
  const startWall = Date.now() - startT0;
  const startFailures = started.filter((r) => r.status === 'rejected');
  step('all tenants started without error', startFailures.length === 0,
    startFailures.length ? String(startFailures[0].reason?.message || '').slice(0, 160) : `${startWall}ms wall`);

  const ready = await Promise.all(pool.map((id) => waitReady(dockerContainerName(id))));
  const notReady = ready.filter((r) => !r.ok);
  step('all gateways reached ready', notReady.length === 0,
    notReady.length ? notReady[0].error?.slice(0, 200) : `slowest ${Math.max(...ready.map((r) => r.ms))}ms`);

  const ports = pool.map((id) => gw.tenantGatewayPort(id));
  step('port allocation collision-free', new Set(ports).size === ports.length, ports.join(','));

  step('warm count matches pool', gw.warmTenantCount() === POOL, `warm=${gw.warmTenantCount()}`);

  console.log('\nCapacity ceiling');
  let refused = null;
  try {
    gw.assertHostCapacity(overflow);
    refused = false;
  } catch (err) {
    refused = String(err?.message || err);
  }
  step('tenant beyond ceiling is refused', refused !== false,
    refused === false ? `admitted a ${POOL + 1}th tenant` : String(refused).slice(0, 120));

  console.log('\nCross-tenant isolation');
  let leaks = [];
  for (const id of pool) {
    const listing = await docker(['exec', dockerContainerName(id), 'sh', '-c', 'cat /tenant/openclaw/marker.txt 2>/dev/null; ls /tenant 2>/dev/null']);
    if (!listing.includes(id)) leaks.push(`${id}: own marker unreadable`);
    for (const other of pool) {
      if (other !== id && listing.includes(other)) leaks.push(`${id} can see ${other}`);
    }
  }
  step('no tenant sees another tenant', leaks.length === 0, leaks.length ? leaks.join('; ').slice(0, 200) : `${POOL} containers checked`);

  const vaultProbe = await docker(['exec', dockerContainerName(pool[0]), 'sh', '-c', 'ls /tenant/vault 2>&1 || true']);
  step('vault unreachable from container', /No such file|cannot access/i.test(vaultProbe), vaultProbe.trim().slice(0, 120));

  console.log('\nConcurrent hibernate');
  const hibT0 = Date.now();
  await Promise.all(pool.map((id) => gw.stopTenantGateway(id)));
  const hibWall = Date.now() - hibT0;
  const states = await Promise.all(pool.map((id) => containerState(dockerContainerName(id))));
  step('all containers stopped, not removed', states.every((s) => s === 'exited'), `${states.join(',')} in ${hibWall}ms`);

  console.log('\nConcurrent wake');
  const wakeT0 = Date.now();
  const woken = await Promise.allSettled(pool.map((id) => gw.startTenantGatewayById(id)));
  const wakeWall = Date.now() - wakeT0;
  const wakeFailures = woken.filter((r) => r.status === 'rejected');
  step('all tenants woke without error', wakeFailures.length === 0,
    wakeFailures.length ? String(wakeFailures[0].reason?.message || '').slice(0, 160) : `${wakeWall}ms wall`);

  const readyAgain = await Promise.all(pool.map((id) => waitReady(dockerContainerName(id))));
  const stillDown = readyAgain.filter((r) => !r.ok);
  step('all gateways ready after wake', stillDown.length === 0,
    stillDown.length ? stillDown[0].error?.slice(0, 200) : `slowest ${Math.max(...readyAgain.map((r) => r.ms))}ms`);

  console.log('\nLatency');
  console.log(`  cold start ${POOL} concurrent (wall)   ${startWall}ms`);
  console.log(`  slowest single cold ready            ${Math.max(...ready.map((r) => r.ms))}ms`);
  console.log(`  hibernate ${POOL} concurrent (wall)    ${hibWall}ms`);
  console.log(`  wake ${POOL} concurrent (wall)         ${wakeWall}ms`);
  console.log(`  slowest single wake ready            ${Math.max(...readyAgain.map((r) => r.ms))}ms`);

  const mem = await docker(['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', ...pool.map((id) => dockerContainerName(id))]);
  console.log('\nMemory');
  console.log(mem.trim().split('\n').map((l) => `  ${l}`).join('\n'));
}

try {
  await main();
} catch (err) {
  console.error('\nGATE POOL ERROR:', err?.message || err);
  failures += 1;
} finally {
  console.log('\nCleanup');
  const { dockerContainerName } = await import('../src/openclaw/docker-gateway.mjs');
  const ids = await fs.readdir(ROOT).catch(() => []);
  for (const id of ids) {
    if (id.startsWith('br_')) await docker(['rm', '-f', dockerContainerName(id)], 60_000);
  }
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  console.log(`  removed ${ids.filter((i) => i.startsWith('br_')).length} containers and ${ROOT}`);
}

console.log(`\n${failures === 0 ? 'GATE POOL PASSED' : 'GATE POOL FAILED'} — ${results.filter((r) => r.ok).length}/${results.length} checks\n`);
process.exit(failures === 0 ? 0 : 1);
