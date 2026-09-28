import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerRunArgs } from '../src/openclaw/docker-gateway.mjs';

function mounts(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-v') out.push(args[i + 1]);
  return out;
}

describe('two-cell docker argv isolation contract', () => {
  it('never mounts another tenant or the tenant root', () => {
    const a = buildDockerRunArgs({ tenantId: 'br_111111111111', port: 18801, token: 'a' });
    const b = buildDockerRunArgs({ tenantId: 'br_222222222222', port: 18802, token: 'b' });
    const mountsA = mounts(a);
    const mountsB = mounts(b);
    assert.equal(mountsA.some((mount) => mount.includes('br_222222222222')), false);
    assert.equal(mountsB.some((mount) => mount.includes('br_111111111111')), false);
    assert.equal(mountsA.some((mount) => mount.includes('/vault')), false);
    assert.equal(mountsB.some((mount) => mount.includes('/vault')), false);
  });
});
