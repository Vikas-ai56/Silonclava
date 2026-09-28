import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeTenantCommand } from '../src/tenant-cli/index.mjs';
import { redactParams } from '../src/tenant-cli/audit.mjs';
import { publicGatewayResult } from '../src/tenant-cli/resources/runtime.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant, tenantDir } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const execFileAsync = promisify(execFile);
const operatorContext = {
  authorization: { kind: 'operator', principal: 'test-suite' },
};

describe('tenant CLI command service', () => {
  it('dispatches resource actions, audits mutations, and does not log auth links', async () => {
    const phone = `1575${String(Date.now()).slice(-8)}`;
    const tenant = await provisionTenant({ phone, jid: `${phone}@s.whatsapp.net`, name: 'CLI Test', plan: 'claude' });
    try {
      const login = await executeTenantCommand([
        'auth', 'login', '--provider', 'claude', '--tenant', tenant.id, '--json',
      ], operatorContext);
      assert.equal(login.ok, true);
      assert.match(login.result.authorizeUrl, /claude\.ai\/oauth\/authorize/);

      const claudeDir = path.join(tenantDir(tenant.id), 'cli-home', 'claude');
      await fs.writeFile(
        path.join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'access-only', expiresAt: Date.now() + 60_000 } }),
      );
      const status = await executeTenantCommand([
        'auth', 'status', '--provider', 'claude', '--tenant', tenant.id,
      ], operatorContext);
      assert.equal(status.result.connected, true);
      assert.equal(status.result.refreshable, false);
      assert.equal(status.result.degraded, true);
      assert.match(status.result.diagnostic, /cannot refresh/i);

      const route = await executeTenantCommand([
        'route', 'set', '--tenant', tenant.id, '--backend', 'openclaw', '--json',
      ], operatorContext);
      assert.equal(route.result.current.backend, 'openclaw');
      const rollback = await executeTenantCommand(
        ['route', 'rollback', '--tenant', tenant.id, '--json'],
        operatorContext,
      );
      assert.equal(rollback.result.current.backend, 'hermes');

      const audit = await fs.readFile(path.join(tenantDir(tenant.id), 'audit.jsonl'), 'utf8');
      assert.match(audit, /"resource":"auth"/);
      assert.match(audit, /"resource":"route"/);
      assert.doesNotMatch(audit, /claude\.ai\/oauth\/authorize|code_challenge|access_token|refresh_token/);

      const binary = path.resolve('bin/tenant.mjs');
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        binary, 'route', 'show', '--tenant', tenant.id, '--json',
      ], { env: process.env });
      assert.equal(stderr, '');
      const json = JSON.parse(stdout);
      assert.equal(json.ok, true);
      assert.equal(stdout.trim().split('\n').length, 1);

      const loginOutput = await execFileAsync(process.execPath, [
        binary, 'auth', 'login', '--provider', 'claude', '--tenant', tenant.id, '--json',
      ], { env: process.env });
      assert.doesNotMatch(
        loginOutput.stdout,
        /claude\.ai\/oauth\/authorize|code_challenge|pastePageUrl|[?&]state=/i,
      );

      await assert.rejects(
        execFileAsync(process.execPath, [
          binary, 'auth', 'complete', '--provider', 'claude', '--tenant', tenant.id,
          '--code', 'must-not-enter-argv', '--json',
        ], { env: process.env }),
        (err) => {
          assert.equal(err.stdout, '');
          assert.match(err.stderr, /pipe the code to stdin/i);
          return true;
        },
      );
    } finally {
      await deleteTenant(tenant.id);
    }
  });

  it('never exposes the warm gateway bearer token in runtime output', () => {
    const output = publicGatewayResult({
      port: 18789,
      token: 'gateway-secret-token',
      url: 'ws://127.0.0.1:18789',
      runtime: 'docker',
    });
    assert.equal(output.token, undefined);
    assert.doesNotMatch(JSON.stringify(output), /gateway-secret-token/);
  });

  it('enforces tenant grants and derives the audit actor from the caller', async () => {
    const phoneA = `1576${String(Date.now()).slice(-8)}`;
    const phoneB = `1577${String(Date.now()).slice(-8)}`;
    const a = await provisionTenant({ phone: phoneA, jid: `${phoneA}@s.whatsapp.net`, name: 'Grant A', plan: 'claude' });
    const b = await provisionTenant({ phone: phoneB, jid: `${phoneB}@s.whatsapp.net`, name: 'Grant B', plan: 'claude' });
    const tenantContext = {
      authorization: { kind: 'tenant', tenantId: a.id, principal: `whatsapp:${a.id}` },
    };
    try {
      await executeTenantCommand(
        ['auth', 'login', '--provider', 'claude', '--tenant', a.id],
        tenantContext,
      );
      await assert.rejects(
        executeTenantCommand(
          ['auth', 'login', '--provider', 'claude', '--tenant', b.id],
          tenantContext,
        ),
        /not authorized/i,
      );
      await assert.rejects(
        executeTenantCommand(['route', 'show', '--tenant', a.id]),
        /not authorized/i,
      );
      await assert.rejects(
        executeTenantCommand(
          ['route', 'show', '--tenant', a.id, '--actor', 'forged'],
          operatorContext,
        ),
        /--actor is not accepted/i,
      );
      const audit = await fs.readFile(path.join(tenantDir(a.id), 'audit.jsonl'), 'utf8');
      assert.match(audit, new RegExp(`"actor":"whatsapp:${a.id}"`));
    } finally {
      await deleteTenant(a.id);
      await deleteTenant(b.id);
    }
  });

  it('redacts secret-shaped values even under generic keys', () => {
    const redacted = redactParams({
      value: 'ordinary-looking-key',
      payload: 'sk-ant-api03-super-secret-material',
      inputData: `${'a'.repeat(24)}#${'b'.repeat(24)}`,
      nested: { note: 'A'.repeat(48) },
    });
    assert.equal(redacted.value, '[REDACTED]');
    assert.equal(redacted.payload, '[REDACTED]');
    assert.equal(redacted.inputData, '[REDACTED]');
    assert.equal(redacted.nested.note, '[REDACTED]');
  });

  it('serializes concurrent route changes and makes rollback append-only and repeatable', async () => {
    const suffix = String(Date.now()).slice(-8);
    const a = await provisionTenant({
      phone: `1581${suffix}`,
      jid: `1581${suffix}@s.whatsapp.net`,
      name: 'Route A',
      plan: 'claude',
    });
    const b = await provisionTenant({
      phone: `1582${suffix}`,
      jid: `1582${suffix}@s.whatsapp.net`,
      name: 'Route B',
      plan: 'claude',
    });
    try {
      await Promise.all([
        executeTenantCommand(
          ['route', 'set', '--tenant', a.id, '--backend', 'openclaw'],
          operatorContext,
        ),
        executeTenantCommand(
          ['route', 'set', '--tenant', b.id, '--backend', 'openclaw'],
          operatorContext,
        ),
      ]);
      const routeFile = path.join(TENANTS_DIR, 'routes.json');
      const afterSets = JSON.parse(await fs.readFile(routeFile, 'utf8'));
      assert.equal(afterSets.routes[a.id].backend, 'openclaw');
      assert.equal(afterSets.routes[b.id].backend, 'openclaw');

      const first = await executeTenantCommand(
        ['route', 'rollback', '--tenant', a.id],
        operatorContext,
      );
      assert.equal(first.result.current.backend, 'hermes');
      const afterFirst = JSON.parse(await fs.readFile(routeFile, 'utf8'));
      const second = await executeTenantCommand(
        ['route', 'rollback', '--tenant', a.id],
        operatorContext,
      );
      const afterSecond = JSON.parse(await fs.readFile(routeFile, 'utf8'));
      assert.equal(second.result.alreadyRolledBack, true);
      assert.equal(afterSecond.history.length, afterFirst.history.length);
      assert.ok(afterSecond.history.some((entry) => entry.operation === 'rollback'));
    } finally {
      await deleteTenant(a.id);
      await deleteTenant(b.id);
    }
  });
});
