import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureTenantCliHome,
  tenantClaudeConfigDir,
  tenantCodexHome,
} from '../src/cli-home.mjs';
import {
  claudeCredentialPresentSync,
  codexCredentialPresentSync,
  codexLoginHelp,
} from '../src/tenant-cli/runtime-credentials.mjs';
import { summarizeDisconnect, appendOpsAlert } from '../src/ops-alert.mjs';
import { ensureTenantOpenclaw } from '../src/openclaw/tenant-openclaw.mjs';
import { ROOT, TENANTS_DIR } from '../src/paths.mjs';
import { rmTenant } from './helpers.mjs';

// The phone-keyed in-memory lane these tests covered was replaced in
// SPEC-phase3c §10 step 2. Coalescing, per-tenant serialization, FIFO order and
// restart recovery are now covered against the durable scheduler in
// test/tenant-scheduler.test.mjs; the busy ack moved to the router and is
// covered in test/router-inbound.test.mjs.

describe('cli-home', () => {
  const tenantId = `__test_cli_${process.pid}`;

  after(async () => {
    await rmTenant(tenantId);
  });

  it('creates isolated claude and codex dirs', async () => {
    const tenant = { id: tenantId };
    const paths = await ensureTenantCliHome(tenant);
    assert.ok(paths.claudeDir.endsWith(path.join('cli-home', 'claude')));
    assert.ok(paths.codexDir.endsWith(path.join('cli-home', 'codex')));
    assert.equal(claudeCredentialPresentSync(tenantId), false);
    assert.equal(codexCredentialPresentSync(tenantId), false);
  });

  it('keeps login detection in provider control-plane modules', async () => {
    await fs.writeFile(path.join(tenantClaudeConfigDir(tenantId), 'notes.txt'), 'not a credential');
    assert.equal(claudeCredentialPresentSync(tenantId), false);
    await fs.writeFile(
      path.join(tenantClaudeConfigDir(tenantId), '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'test-access',
          refreshToken: 'test-refresh',
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    assert.equal(claudeCredentialPresentSync(tenantId), true);

    await fs.writeFile(path.join(tenantCodexHome(tenantId), 'auth.json'), '{}');
    assert.equal(codexCredentialPresentSync(tenantId), true);

    const codexHelp = codexLoginHelp();
    assert.match(codexHelp, /disabled/i);
    assert.match(codexHelp, /Codex/i);
  });
});

describe('ops-alert disconnect summary', () => {
  it('extracts status and conflict type from boom-like errors', () => {
    const err = {
      isBoom: true,
      message: 'Stream Errored (conflict)',
      name: 'Boom',
      output: { statusCode: 401, payload: { statusCode: 401, error: 'Unauthorized' } },
      data: {
        content: [{ tag: 'conflict', attrs: { type: 'device_removed' } }],
      },
    };
    const detail = summarizeDisconnect(err, 401);
    assert.equal(detail.statusCode, 401);
    assert.equal(detail.conflictType, 'device_removed');
    assert.match(detail.message, /conflict/i);
  });

  it('appends alerts to ops log', async () => {
    const row = await appendOpsAlert('test_alert', { hello: 'world', at: new Date().toISOString() });
    assert.equal(row.type, 'test_alert');
    const logPath = path.join(ROOT, 'ops', 'alerts.jsonl');
    const text = await fs.readFile(logPath, 'utf8');
    assert.match(text, /test_alert/);
  });
});

describe('openclaw tenant config', () => {
  const tenantId = `__test_oc_${process.pid}`;
  const dir = path.join(TENANTS_DIR, tenantId);

  after(async () => {
    await rmTenant(tenantId);
  });

  it('writes claude-cli runtime for claude plan', async () => {
    const workspace = path.join(dir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const tenant = {
      id: tenantId,
      phone: '15550004444',
      plan: 'claude',
      workspacePath: workspace,
    };
    const { configPath, config } = await ensureTenantOpenclaw(tenant);
    const disk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(disk.agents.defaults.model.primary, config.agents.defaults.model.primary);
    const primary = disk.agents.defaults.model.primary;
    assert.equal(disk.agents.defaults.models[primary].agentRuntime.id, 'claude-cli');
  });

  it('generates a config the pinned OpenClaw image accepts', async () => {
    const workspace = path.join(dir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const tenant = {
      id: tenantId,
      phone: '15550004444',
      plan: 'claude',
      workspacePath: workspace,
    };
    const { config } = await ensureTenantOpenclaw(tenant);

    // `cron.skipMissedJobs` does not exist in openclaw@2026.7.1-2 and its
    // schema is strict, so emitting it made every container fail to start.
    // Guarded here because unit tests cannot see the real schema; the Docker
    // smoke test is what actually validates it.
    assert.equal(config.cron.skipMissedJobs, undefined);
    assert.deepEqual(Object.keys(config.cron), []);
  });

  it('writes codex runtime for codex plan', async () => {
    const workspace = path.join(dir, 'workspace');
    const tenant = {
      id: tenantId,
      phone: '15550004444',
      plan: 'codex',
      workspacePath: workspace,
    };
    const { config } = await ensureTenantOpenclaw(tenant);
    const primary = config.agents.defaults.model.primary;
    assert.match(primary, /^openai\//);
    assert.equal(config.agents.defaults.models[primary].agentRuntime.id, 'codex');
  });
});
