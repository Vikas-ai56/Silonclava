import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  gatewayMetaPath,
  readGatewayMeta,
  writeGatewayMeta,
} from '../src/openclaw/docker-gateway.mjs';
import { rmTenant, tempTenantId } from './helpers.mjs';
import { OPENCLAW_DOCKER_IMAGE } from '../src/config.mjs';

describe('docker gateway metadata (no docker run)', () => {
  const id = tempTenantId('1560');

  after(async () => {
    await rmTenant(id);
  });

  it('gatewayMetaPath lives under tenant openclaw dir', () => {
    const p = gatewayMetaPath(id);
    assert.match(p, new RegExp(`${id}[/\\\\]openclaw[/\\\\]\\.rocky-gw\\.json`));
  });

  it('writeGatewayMeta and readGatewayMeta round-trip', async () => {
    const meta = {
      runtime: 'docker',
      container: `rocky-oc-local-${id}`,
      port: 19123,
      token: 'secret',
      image: OPENCLAW_DOCKER_IMAGE,
    };
    await writeGatewayMeta(id, meta);
    const disk = await readGatewayMeta(id);
    assert.equal(disk.container, meta.container);
    assert.equal(disk.port, 19123);
    await fs.access(gatewayMetaPath(id));
  });

  it('readGatewayMeta returns null when missing', async () => {
    const missing = tempTenantId('1561');
    assert.equal(await readGatewayMeta(missing), null);
  });
});
