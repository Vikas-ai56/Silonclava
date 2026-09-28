import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PHASE,
  ONBOARDING_STEPS,
  stepsForPhase,
  runTenantOnboarding,
  ensureAgentCredential,
} from '../src/openclaw/tenant-onboarding.mjs';
import { readGatewayMeta } from '../src/openclaw/docker-gateway.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_onb_${tag}_${process.pid}`;
  ids.push(id);
  const dir = path.join(TENANTS_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'openclaw'), { recursive: true });
  return id;
}
after(() => { for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true }); });

describe('tenant onboarding sequence', () => {
  it('runs on both a new container and a woken one', () => {
    assert.ok(stepsForPhase(PHASE.CREATE).length > 0);
    assert.ok(stepsForPhase(PHASE.WAKE).length > 0);
    for (const s of ONBOARDING_STEPS) {
      assert.ok(s.phases.length > 0, `${s.name} belongs to no phase`);
      assert.equal(typeof s.run, 'function');
    }
  });

  it('checks bind-mount sources only when waking, never when creating', () => {
    const names = (p) => stepsForPhase(p).map((s) => s.name);
    assert.ok(names(PHASE.WAKE).includes('bind-mount sources still exist'));
    assert.ok(!names(PHASE.CREATE).includes('bind-mount sources still exist'),
      'a container being created has no mounts to check yet');
  });

  it('mints the agent credential once and reuses it afterwards', async () => {
    const id = freshTenant('cred');
    const first = await ensureAgentCredential(id);
    assert.equal(first.minted, true);
    assert.ok(first.token.length >= 64);

    const second = await ensureAgentCredential(id);
    assert.equal(second.minted, false, 'a woken agent must keep its credential');
    assert.equal(second.token, first.token);

    const meta = await readGatewayMeta(id);
    assert.equal(meta.agentToken, first.token, 'the credential outlives the container');
  });

  it('preserves existing gateway metadata when minting', async () => {
    const id = freshTenant('meta');
    const { writeGatewayMeta } = await import('../src/openclaw/docker-gateway.mjs');
    await writeGatewayMeta(id, { runtime: 'docker', port: 19999, token: 'gw-token' });
    await ensureAgentCredential(id);
    const meta = await readGatewayMeta(id);
    assert.equal(meta.port, 19999, 'minting must not discard the gateway port');
    assert.equal(meta.token, 'gw-token');
    assert.ok(meta.agentToken);
  });

  // dockerRunGateway wrote the gateway metadata wholesale, which silently
  // discarded the agent credential on every container rebuild (caught live,
  // 2026-09-20: "credential after wake: MINTED").
  it('survives a container rebuild writing its own gateway metadata', async () => {
    const id = freshTenant('rebuild');
    const { writeGatewayMeta } = await import('../src/openclaw/docker-gateway.mjs');
    const minted = await ensureAgentCredential(id);

    const existing = (await readGatewayMeta(id)) || {};
    await writeGatewayMeta(id, { ...existing, runtime: 'docker', port: 19001, token: 'gw' });

    const after = await ensureAgentCredential(id);
    assert.equal(after.minted, false, 'a container rebuild must not re-mint the credential');
    assert.equal(after.token, minted.token);
  });

  it('stops at the first required failure and reports which step', async () => {
    const out = await runTenantOnboarding(PHASE.CREATE, {
      tenantId: 'br_does_not_exist_at_all',
      containerName: 'none',
    });
    assert.equal(out.ok, false);
    const failed = out.results.find((r) => !r.ok);
    assert.equal(failed.name, 'tenant directory exists');
    assert.equal(out.results.length, 1, 'later steps must not run after a required failure');
  });
});
