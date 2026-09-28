import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

/**
 * SPEC-phase3c §1.4/§3: the pool is a supervisor, not a cache. These assert the
 * *absence* of eviction, because an idle timer that silently stops a container
 * also silently stops that tenant's cron — a failure with no error and no log.
 */
const source = await fs.readFile('src/openclaw/tenant-gateway.mjs', 'utf8');

describe('gateway hibernation (SPEC-phase3c §1.4)', () => {
  it('hibernates on idle but never mid-turn', () => {
    assert.match(source, /function scheduleIdleStop/);
    // inFlight is decremented only on a terminal result, so a container serving
    // a user turn must re-arm the timer rather than stop.
    const fn = source.slice(source.indexOf('function scheduleIdleStop'));
    assert.match(fn.slice(0, 900), /inFlight > 0/);
    assert.match(fn.slice(0, 900), /scheduleIdleStop\(tenantId\);/);
  });

  it('re-arms the idle timer only from user activity, never from cron', () => {
    // The load-bearing rule: if job execution reset the timer, a nightly cron
    // would keep every container resident and hibernation would reclaim nothing.
    const touch = source.slice(source.indexOf('function touchEntry'), source.indexOf('function clearIdleTimer'));
    assert.match(touch, /lastUserRequestAt/);
    assert.match(touch, /scheduleIdleStop/);

    // The cron wake path must not call touchEntry.
    const wake = fsSync.readFileSync('src/wake-scheduler.mjs', 'utf8');
    assert.doesNotMatch(wake, /touchEntry/, 'cron must not reset the user idle timer');
  });

  it('has no LRU capacity eviction; capacity is admission plus explicit preemption', () => {
    // Match executable code only. The original regex read comments too, so
    // documenting the absence of eviction (BL-016) failed the guard that
    // exists to prove its absence.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Eviction exists as of 2026-09-21, but never of work in flight: the
    // policy filters on inFlight before anything else.
    const policy = fsSync.readFileSync('src/openclaw/admission.mjs', 'utf8');
    assert.match(policy, /if \(\(e\.inFlight \|\| 0\) > 0\) continue;/);
    assert.doesNotMatch(code, /lastUsedAt/, 'recency-only bookkeeping must not return');
  });

  it('routes capacity through the admission policy, which may evict', async () => {
    // Replaced 2026-09-21. The ceiling used to refuse; it now evicts an idle
    // overdue container or waits. See docs/features/10-admission-and-eviction.md.
    assert.match(source, /const admission = await admitTenant\(tenantId\)/);
    const at = source.indexOf('const admission = await admitTenant');
    const setAt = source.indexOf('pool.set(tenantId, {');
    assert.ok(at > 0 && setAt > 0 && at < setAt, 'admission must run before the pool insert');
  });


  it('exposes generation and inFlight for turn correlation and drain', () => {
    for (const api of [
      'export function acquireTenantRuntime',
      'export function releaseTenantRuntime',
      'export function isCurrentGeneration',
      'export function tenantInFlight',
      'export function totalInFlight',
    ]) {
      assert.ok(source.includes(api), `missing ${api}`);
    }
  });

  it('increments the generation per creation and never reuses it', async () => {
    const mod = await import('../src/openclaw/tenant-gateway.mjs');
    // Generations are keyed outside the pool so a removed-and-recreated
    // container cannot inherit its predecessor's number.
    assert.match(source, /const generations = new Map\(\)/);
    const nextGen = source.slice(source.indexOf('function nextGeneration'));
    assert.match(nextGen.slice(0, 220), /generations\.get\(tenantId\) \|\| 0\) \+ 1/);
    assert.equal(typeof mod.isCurrentGeneration, 'function');
    assert.equal(mod.isCurrentGeneration('br_never_started', 1), false);
  });
});

describe('terminal model completion (§2)', () => {
  it('no longer resolves a turn on a quiet token stream', async () => {
    const oc = await fs.readFile('src/openclaw/tenant-openclaw.mjs', 'utf8');
    for (const banned of ['DELTA_IDLE_MS', 'deltaIdlePromise', 'resetDeltaIdle', 'deltaIdleResolver']) {
      assert.doesNotMatch(
        oc,
        new RegExp(banned),
        `${banned}: a pause in deltas is not a finished response`,
      );
    }
  });

  it('does not retry the model inside a turn', async () => {
    const oc = await fs.readFile('src/openclaw/tenant-openclaw.mjs', 'utf8');
    assert.doesNotMatch(oc, /retrying once/);
    // Exactly one --local invocation remains in the cold fallback path.
    const locals = oc.match(/local: true,/g) || [];
    assert.equal(locals.length, 1, `expected one cold-fallback invocation, found ${locals.length}`);
  });
});

describe('host-owned restart supervision (§3)', () => {
  it('keeps --restart no so the host observes every restart', async () => {
    const dg = await fs.readFile('src/openclaw/docker-gateway.mjs', 'utf8');
    assert.match(dg, /'--restart',\s*\n?\s*'no',/);
    // Docker's own policies would restart behind the host's back, leaving the
    // generation counter stale so a pre-restart reply still validates.
    assert.doesNotMatch(dg, /unless-stopped|always'|on-failure/);
  });

  it('restarts a container the host finds not running', async () => {
    const { superviseOnce, superviseTenant, unsuperviseTenant } =
      await import('../src/openclaw/tenant-gateway.mjs');
    const started = [];
    superviseTenant('br_supervise_a');
    try {
      const restarted = await superviseOnce({
        start: async (id) => { started.push(id); },
        containerState: async () => 'exited',
      });
      assert.deepEqual(started, ['br_supervise_a']);
      assert.deepEqual(restarted, ['br_supervise_a']);
    } finally {
      unsuperviseTenant('br_supervise_a');
    }
  });

  it('stops orphan containers but never touches foreign ones', async () => {
    const { reconcileContainers } = await import('../src/openclaw/tenant-gateway.mjs');
    const { dockerContainerName } = await import('../src/openclaw/docker-gateway.mjs');
    const stopped = [];
    const orphans = await reconcileContainers(['br_known'], {
      list: async () => [
        dockerContainerName('br_known'),
        dockerContainerName('br_vanished'),
        'postgres',                 // not ours
        'some-other-app',           // not ours
      ],
      stop: async (n) => { stopped.push(n); },
      remove: async () => {},
    });
    assert.deepEqual(orphans, [dockerContainerName('br_vanished')]);
    assert.deepEqual(stopped, [dockerContainerName('br_vanished')]);
    assert.ok(!stopped.includes('postgres'), 'must never stop a foreign container');
  });
});

describe('host capacity ceiling (§3)', () => {
  it('is NOT enforced at provisioning: registration is not a warm slot', async () => {
    // Reversed 2026-09-21. The old rationale was "containers are always on, so
    // admitting one we cannot start creates a tenant whose cron never fires" —
    // a premise that died when hibernation replaced always-on on 2026-09-18.
    const provision = await fs.readFile('src/provision.mjs', 'utf8');
    assert.doesNotMatch(provision, /assertHostCapacity/);
  });


  it('no longer speaks of a warm cache', async () => {
    const cfg = await fs.readFile('src/config.mjs', 'utf8');
    assert.match(cfg, /MAX_TENANTS_PER_HOST/);
    // The old env var keeps working so deployments do not break.
    assert.match(cfg, /ROCKY_OPENCLAW_MAX_WARM/);
    const idx = await fs.readFile('src/index.mjs', 'utf8');
    assert.doesNotMatch(idx, /idle=\$\{OPENCLAW_GATEWAY_IDLE_MS\}/, 'idle eviction is gone');
  });

  it('refuses rather than evicting when the ceiling is reached', () => {
    const fn = source.slice(
      source.indexOf('export function assertHostCapacity'),
      source.indexOf('export function isOpenclawWarmEnabled'),
    );
    assert.match(fn, /HostCapacityExceededError/);
    assert.doesNotMatch(fn, /stopTenantGateway/);
  });
});

describe('SQL stays behind the repository boundary', () => {
  it('has no prepare() outside src/tenant-data', async () => {
    const offenders = [];
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === 'tenant-data') continue;
          await walk(full);
        } else if (e.name.endsWith('.mjs')) {
          const text = await fs.readFile(full, 'utf8');
          if (/\.prepare\(/.test(text)) offenders.push(full);
        }
      }
    };
    await walk('src');
    assert.deepEqual(
      offenders,
      [],
      `SQL belongs in the queue-store/repository layer, not in: ${offenders.join(', ')}`,
    );
  });
});
