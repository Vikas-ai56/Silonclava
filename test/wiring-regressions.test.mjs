import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync('src/router.mjs', 'utf8');
const index = fs.readFileSync('src/index.mjs', 'utf8');
const gateway = fs.readFileSync('src/openclaw/tenant-gateway.mjs', 'utf8');
const docker = fs.readFileSync('src/openclaw/docker-gateway.mjs', 'utf8');

test('a committed response is re-sent at boot, not silently dropped', async (t) => {
  await t.test('the sweep exists and boot calls it', () => {
    assert.match(router, /export async function resendAllCommittedResponses/);
    assert.match(index, /await resendAllCommittedResponses\(channel\)/);
  });

  await t.test('it runs after lane recovery, which handles a different state', () => {
    const recover = index.indexOf('recoverAllTenantLanes({');
    const resend = index.indexOf('resendAllCommittedResponses(channel)');
    assert.ok(recover > 0 && resend > recover, 'resend must follow recovery');
  });

  await t.test('it re-sends committed bytes rather than re-running the model', () => {
    const fn = router.slice(router.indexOf('export async function resendCommittedResponses'));
    assert.match(fn.slice(0, 900), /committedResponseText/);
    assert.doesNotMatch(fn.slice(0, 900), /runTurn|runAgentTurn/);
  });
});

test('supervision supervises something', async (t) => {
  await t.test('tenants enter the supervised set when a gateway starts', () => {
    assert.match(gateway, /pool\.set\(tenantId, entry\);\s*\n\s*superviseTenant\(tenantId\);/);
  });

  // Hibernation and eviction both route through stopTenantGateway. If they did
  // not unsupervise, the supervisor would fight admission for host memory.
  await t.test('a deliberate stop unsupervises, so hibernation is not undone', () => {
    const fn = gateway.slice(gateway.indexOf('export async function stopTenantGateway'));
    assert.match(fn.slice(0, 200), /unsuperviseTenant\(tenantId\)/);
  });
});

test('the generation fence survives a gateway restart', async (t) => {
  await t.test('generation is persisted, not only held in memory', () => {
    assert.match(docker, /generation: Number\(existingMeta\.generation \|\| 0\) \+ 1/);
  });

  await t.test('the in-memory counter is seeded from the persisted value', () => {
    assert.match(gateway, /function seedGeneration\(tenantId, persisted\)/);
    assert.match(gateway, /seedGeneration\(tenantId, meta\?\.generation\)/);
    assert.match(gateway, /seedGeneration\(tenantId, meta\.generation\)/);
  });

  await t.test('the meta write still merges, so the agent token survives', () => {
    const write = docker.slice(docker.indexOf('const existingMeta'));
    assert.match(write.slice(0, 400), /\.\.\.existingMeta/);
  });
});

test('twilio is the only transport and an unknown channel fails loud', async (t) => {
  await t.test('the default is twilio', () => {
    assert.match(index, /process\.env\.ROCKY_CHANNEL \|\| 'twilio'/);
  });

  await t.test('there is no baileys branch and no silent mock fallback', () => {
    assert.doesNotMatch(index, /baileys-channel/);
    assert.doesNotMatch(index, /falling back to mock/);
  });

  await t.test('an unknown channel throws instead of degrading', () => {
    assert.match(index, /Unknown ROCKY_CHANNEL=\$\{requested\}/);
  });

  await t.test('no dropped dependency is still declared', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dead of ['@whiskeysockets/baileys', '@hapi/boom', 'pino', 'qrcode', 'libsignal']) {
      assert.equal(all[dead], undefined, `${dead} must be gone`);
    }
    assert.equal(pkg.overrides, undefined);
  });
});
