import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, loadTenant } from '../src/tenants.mjs';
import {
  resolveOpenclawRunContext,
  ensureTenantOpenclaw,
  tenantOpenclawConfigPath,
} from '../src/openclaw/tenant-openclaw.mjs';
import {
  enqueueForTenant,
  configureScheduler,
  resetScheduler,
} from '../src/inbound-queue.mjs';
import { turnMessageIds } from '../src/tenant-data/queue-store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { decryptBody } from '../src/tenant-data/store.mjs';

const suffix = `${process.pid}${Date.now().toString().slice(-4)}`;
const phoneA = `15570${suffix}`.slice(0, 15);
const phoneB = `15571${suffix}`.slice(0, 15);
const createdIds = [];
const credential = (who) => JSON.stringify({
  claudeAiOauth: {
    accessToken: `test-access-${who}`,
    refreshToken: `test-refresh-${who}`,
    expiresAt: Date.now() + 60_000,
  },
});

after(async () => {
  for (const id of createdIds) await deleteTenant(id);
  for (const id of createdIds) assert.equal(await loadTenant(id), null);
});

function assertDisjoint(a, b, label) {
  assert.notEqual(a, b, `${label} must differ between tenants`);
  assert.ok(!String(a).startsWith(String(b) + path.sep) && !String(b).startsWith(String(a) + path.sep),
    `${label} paths must not nest`);
}

describe('multi-tenant OpenClaw isolation', () => {
  it('two temporary tenants get disjoint dirs, env, and session markers (cleaned up after)', async () => {
    const tenantA = await provisionTenant({
      phone: phoneA,
      jid: `${phoneA}@s.whatsapp.net`,
      name: 'Isolate A',
      plan: 'claude',
    });
    const tenantB = await provisionTenant({
      phone: phoneB,
      jid: `${phoneB}@s.whatsapp.net`,
      name: 'Isolate B',
      plan: 'claude',
    });
    createdIds.push(tenantA.id, tenantB.id);

    // Simulate per-user MCP / vault markers (no shared Google account file)
    await fs.writeFile(path.join(tenantA.vaultPath, 'marker-a.txt'), 'A-only');
    await fs.writeFile(path.join(tenantB.vaultPath, 'marker-b.txt'), 'B-only');
    const seedMcpServer = async (tenant, name, url) => {
      const file = tenantOpenclawConfigPath(tenant.id);
      await ensureTenantOpenclaw(tenant);
      const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
      cfg.mcp = cfg.mcp || {};
      cfg.mcp.servers = { ...(cfg.mcp.servers || {}), [name]: { url, enabled: false } };
      await fs.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    };
    await seedMcpServer(tenantA, 'tenant-a', 'https://a.example/mcp');
    await seedMcpServer(tenantB, 'tenant-b', 'https://b.example/mcp');

    const ctxA = await resolveOpenclawRunContext(tenantA);
    const ctxB = await resolveOpenclawRunContext(tenantB);

    assertDisjoint(ctxA.stateDir, ctxB.stateDir, 'OPENCLAW_STATE_DIR');
    assertDisjoint(ctxA.configPath, ctxB.configPath, 'OPENCLAW_CONFIG_PATH');
    assertDisjoint(ctxA.workspace, ctxB.workspace, 'OPENCLAW_WORKSPACE_DIR');
    assertDisjoint(ctxA.env.OPENCLAW_HOME, ctxB.env.OPENCLAW_HOME, 'OPENCLAW_HOME');
    assert.notEqual(ctxA.gatewayPort, ctxB.gatewayPort, 'warm gateway ports must differ');
    assert.equal(ctxA.config.gateway.port, ctxA.gatewayPort);
    assert.equal(ctxB.config.gateway.port, ctxB.gatewayPort);

    // Fake CLI login markers so spawn env includes CLAUDE_CONFIG_DIR (no host fallback needed)
    await fs.writeFile(path.join(tenantA.claudeConfigDir, '.credentials.json'), credential('A'));
    await fs.writeFile(path.join(tenantB.claudeConfigDir, '.credentials.json'), credential('B'));
    const envA = (await resolveOpenclawRunContext(tenantA)).env;
    const envB = (await resolveOpenclawRunContext(tenantB)).env;
    assertDisjoint(envA.CLAUDE_CONFIG_DIR, envB.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR');
    assert.match(envA.CLAUDE_CONFIG_DIR, new RegExp(tenantA.id));
    assert.match(envB.CLAUDE_CONFIG_DIR, new RegExp(tenantB.id));

    // Session-like files must not bleed across openclaw state dirs
    await fs.mkdir(path.join(ctxA.stateDir, 'agents', 'main', 'sessions'), { recursive: true });
    await fs.mkdir(path.join(ctxB.stateDir, 'agents', 'main', 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(ctxA.stateDir, 'agents', 'main', 'sessions', 'session-a.jsonl'),
      '{"tenant":"A"}\n',
    );
    await fs.writeFile(
      path.join(ctxB.stateDir, 'agents', 'main', 'sessions', 'session-b.jsonl'),
      '{"tenant":"B"}\n',
    );

    await assert.rejects(
      fs.access(path.join(ctxA.stateDir, 'agents', 'main', 'sessions', 'session-b.jsonl')),
    );
    await assert.rejects(
      fs.access(path.join(ctxB.stateDir, 'agents', 'main', 'sessions', 'session-a.jsonl')),
    );
    await assert.rejects(fs.access(path.join(tenantA.vaultPath, 'marker-b.txt')));
    await assert.rejects(fs.access(path.join(tenantB.vaultPath, 'marker-a.txt')));

    // MCP configs stay private
    const ocA = JSON.parse(await fs.readFile(ctxA.configPath, 'utf8'));
    const ocB = JSON.parse(await fs.readFile(ctxB.configPath, 'utf8'));
    assert.ok(ocA.mcp.servers['tenant-a']);
    assert.equal(ocA.mcp.servers['tenant-b'], undefined);
    assert.ok(ocB.mcp.servers['tenant-b']);
    assert.equal(ocB.mcp.servers['tenant-a'], undefined);

    // Concurrent inbound routing stays separate. Lanes are keyed on resolved
    // tenant.id now, so this asserts isolation of the real routing key rather
    // than of two phone strings.
    const hits = [];
    configureScheduler({
      runTurn: async ({ tenantId, store, turn }) => {
        const [messageId] = turnMessageIds(store, turn.id);
        const row = store.db.prepare('SELECT body_cipher FROM messages WHERE id = ?').get(messageId);
        hits.push(`${tenantId}:${decryptBody(tenantId, row.body_cipher)}`);
        return { state: TURN_STATE.COMPLETED };
      },
    });
    enqueueForTenant(tenantA.id, {
      conversationId: tenantA.id,
      channel: 'whatsapp',
      channelAccount: `${phoneA}@s.whatsapp.net`,
      body: 'from-A',
    });
    enqueueForTenant(tenantB.id, {
      conversationId: tenantB.id,
      channel: 'whatsapp',
      channelAccount: `${phoneB}@s.whatsapp.net`,
      body: 'from-B',
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(hits.includes(`${tenantA.id}:from-A`), `missing A in ${hits}`);
    assert.ok(hits.includes(`${tenantB.id}:from-B`), `missing B in ${hits}`);
    resetScheduler();
  });
});
