import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ORG_DIR } from '../src/paths.mjs';
import { tenantDir } from '../src/tenants.mjs';
import { buildDockerRunArgs } from '../src/openclaw/docker-gateway.mjs';

function valuesAfter(args, flag) {
  const values = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) values.push(args[i + 1]);
  return values;
}

describe('container argv mount contract', () => {
  it('mounts only workspace, state, Claude home, and read-only org', () => {
    const tenantId = 'br_cccccccccccc';
    const args = buildDockerRunArgs({ tenantId, port: 18789, token: 'test-token' });
    const mounts = valuesAfter(args, '-v');
    assert.equal(mounts.length, 4);
    assert.ok(mounts.includes(`${path.join(tenantDir(tenantId), 'workspace')}:/tenant/workspace:rw`));
    assert.ok(mounts.includes(`${path.join(tenantDir(tenantId), 'openclaw')}:/tenant/openclaw:rw`));
    assert.ok(mounts.includes(`${path.join(tenantDir(tenantId), 'cli-home', 'claude')}:/tenant/cli-home/claude:rw`));
    assert.ok(mounts.includes(`${ORG_DIR}:/org:ro`));
    assert.equal(mounts.some((mount) => mount.includes('/vault')), false);
    assert.equal(mounts.some((mount) => mount.endsWith(':/tenant')), false);
  });
});
