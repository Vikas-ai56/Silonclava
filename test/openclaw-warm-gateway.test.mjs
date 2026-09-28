import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  dockerContainerName,
  toDockerBindPath,
} from '../src/openclaw/docker-gateway.mjs';
import {
  tenantGatewayPort,
  gatewayWsUrl,
  isOpenclawWarmEnabled,
  openclawRuntime,
  warmGatewayStats,
  stopAllTenantGateways,
} from '../src/openclaw/tenant-gateway.mjs';
import {
  OPENCLAW_GATEWAY_PORT_BASE,
  OPENCLAW_GATEWAY_IDLE_MS,
  OPENCLAW_RUNTIME,
} from '../src/config.mjs';

describe('openclaw warm gateway helpers', () => {
  it('derives stable disjoint ports for different tenants', () => {
    const a = tenantGatewayPort('15550001111');
    const b = tenantGatewayPort('15551234567');
    assert.equal(a, tenantGatewayPort('15550001111'));
    assert.notEqual(a, b);
    assert.ok(a >= OPENCLAW_GATEWAY_PORT_BASE);
    assert.ok(a < OPENCLAW_GATEWAY_PORT_BASE + 900);
    assert.ok(b >= OPENCLAW_GATEWAY_PORT_BASE);
    assert.ok(b < OPENCLAW_GATEWAY_PORT_BASE + 900);
  });

  it('builds loopback ws url', () => {
    assert.equal(gatewayWsUrl(19123), 'ws://127.0.0.1:19123');
  });

  it('exposes warm defaults and empty pool stats', async () => {
    assert.equal(typeof isOpenclawWarmEnabled(), 'boolean');
    assert.ok(OPENCLAW_GATEWAY_IDLE_MS >= 60_000);
    assert.ok(openclawRuntime() === 'spawn' || openclawRuntime() === 'docker');
    assert.equal(openclawRuntime(), OPENCLAW_RUNTIME);
    await stopAllTenantGateways();
    assert.deepEqual(warmGatewayStats(), {});
  });
});

describe('docker gateway helpers', () => {
  it('names containers safely per tenant and instance', () => {
    assert.equal(dockerContainerName('15550001111', 'local'), 'rocky-oc-local-15550001111');
    assert.equal(dockerContainerName('15550001111', 'sg1'), 'rocky-oc-sg1-15550001111');
    assert.notEqual(
      dockerContainerName('15550001111', 'local'),
      dockerContainerName('15550001111', 'sg1'),
    );
    assert.equal(dockerContainerName('bad id!', 'local'), 'rocky-oc-local-badid');
  });

  it('converts Windows paths for Docker bind mounts', () => {
    if (process.platform === 'win32') {
      const p = toDockerBindPath('D:\\rocky\\tenants\\123');
      assert.match(p, /^\/d\//);
      assert.ok(!p.includes('\\'));
    } else {
      assert.equal(toDockerBindPath('/var/rocky/tenants/123'), path.resolve('/var/rocky/tenants/123'));
    }
  });

  it('keeps tenant bind paths isolated by id', () => {
    const a = toDockerBindPath(path.join('tenants', '111'));
    const b = toDockerBindPath(path.join('tenants', '222'));
    assert.notEqual(a, b);
    assert.ok(a.includes('111'));
    assert.ok(b.includes('222'));
  });
});
