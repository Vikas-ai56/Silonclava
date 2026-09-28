import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileContainers } from '../src/openclaw/tenant-gateway.mjs';
import { dockerContainerName, rockyContainerPrefix } from '../src/openclaw/docker-gateway.mjs';
import { ROCKY_INSTANCE_ID } from '../src/config.mjs';

/**
 * Guards the bug that removed a live tenant's container mid-turn
 * (measured 2026-09-18): a boot smoke test with an empty ROCKY_TENANTS_DIR saw
 * every container as an orphan.
 */
describe('reconciliation refuses to act on an empty tenant list', () => {
  it('removes nothing when containers exist but no tenants are known', async () => {
    const stopped = [];
    const orphans = await reconcileContainers([], {
      list: async () => [dockerContainerName('br_live_one'), dockerContainerName('br_live_two')],
      stop: async (n) => { stopped.push(n); },
      remove: async (n) => { stopped.push(n); },
    });
    // "Every tenant vanished" is far less likely than "wrong tenant root".
    assert.deepEqual(orphans, [], 'must report no orphans');
    assert.deepEqual(stopped, [], 'must stop nothing — this is the destructive case');
  });

  it('still reconciles normally when at least one tenant is known', async () => {
    const stopped = [];
    const orphans = await reconcileContainers(['br_known'], {
      list: async () => [dockerContainerName('br_known'), dockerContainerName('br_vanished')],
      stop: async (n) => { stopped.push(n); },
      remove: async () => {},
    });
    assert.deepEqual(orphans, [dockerContainerName('br_vanished')]);
    assert.deepEqual(stopped, [dockerContainerName('br_vanished')]);
  });

  it('is a no-op when there are no containers at all', async () => {
    const orphans = await reconcileContainers([], { list: async () => [], stop: async () => {}, remove: async () => {} });
    assert.deepEqual(orphans, []);
  });
});

describe('instance namespace cannot collide across tenant roots', () => {
  it('derives the default from the tenant root, not a shared constant', async () => {
    // The old default was the bare string `local`, shared by every process on
    // the host regardless of which tenants directory it was using.
    assert.notEqual(ROCKY_INSTANCE_ID, 'local', 'the bare shared default must not return');
    assert.match(rockyContainerPrefix(), /^rocky-oc-.+-$/);
  });

  it('gives a different namespace to a different tenant root', async () => {
    const mod = async (env) => {
      const saved = process.env.ROCKY_TENANTS_DIR;
      const savedId = process.env.ROCKY_INSTANCE_ID;
      delete process.env.ROCKY_INSTANCE_ID;
      process.env.ROCKY_TENANTS_DIR = env;
      try {
        const url = new URL('../src/config.mjs', import.meta.url);
        url.searchParams.set('v', `${Date.now()}${Math.random()}`);
        // Must await inside the try: `finally` would otherwise restore the env
        // before the module body evaluates, and both imports would read the
        // same value — the test would pass or fail for the wrong reason.
        return await import(url.href);
      } finally {
        if (saved === undefined) delete process.env.ROCKY_TENANTS_DIR;
        else process.env.ROCKY_TENANTS_DIR = saved;
        if (savedId !== undefined) process.env.ROCKY_INSTANCE_ID = savedId;
      }
    };
    const a = await mod('/tmp/rocky-root-a');
    const b = await mod('/tmp/rocky-root-b');
    assert.notEqual(
      a.ROCKY_INSTANCE_ID,
      b.ROCKY_INSTANCE_ID,
      'two roots sharing a namespace is what let one instance delete another’s containers',
    );
  });
});
