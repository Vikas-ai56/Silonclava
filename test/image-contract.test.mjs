import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTAINER_RUNTIME_DIR,
  CONTAINER_MCP_INPUT_DIR,
  CONTAINER_MCP_PROJECTION,
} from '../src/openclaw/container-paths.mjs';

const DOCKERFILE = fs.readFileSync('Dockerfile.openclaw', 'utf8');
const ENTRYPOINT = fs.readFileSync('docker/openclaw/entrypoint.sh', 'utf8');

test('the image and the host agree on the container paths', async (t) => {
  await t.test('the Dockerfile declares the contract the host asserts', () => {
    assert.match(DOCKERFILE, new RegExp(`dev\\.rocky\\.contract\\.runtime-dir="${CONTAINER_RUNTIME_DIR}"`));
    assert.match(DOCKERFILE, new RegExp(`dev\\.rocky\\.contract\\.mcp-input-dir="${CONTAINER_MCP_INPUT_DIR}"`));
  });

  // The original defect: the entrypoint read /run/rift-input while the host
  // mounted /run/rocky-input, and ENOENT was swallowed, so the container
  // started with no MCP servers and never said so.
  await t.test('the entrypoint reads the path the host mounts', () => {
    assert.ok(
      ENTRYPOINT.includes(CONTAINER_MCP_PROJECTION),
      `entrypoint.sh must read ${CONTAINER_MCP_PROJECTION}`,
    );
    assert.ok(ENTRYPOINT.includes(`mkdir -p ${CONTAINER_RUNTIME_DIR}`));
  });

  // Comments may name the old path to explain the bug; nothing executable may.
  await t.test('no rift path survives in either end of the contract', () => {
    const code = (text, comment) => text.replace(new RegExp(`^\\s*${comment}.*$`, 'gm'), '');
    assert.doesNotMatch(code(ENTRYPOINT, '#|//'), /rift/i);
    assert.doesNotMatch(code(DOCKERFILE, '#'), /rift/i);
    assert.doesNotMatch(
      code(fs.readFileSync('src/openclaw/container-paths.mjs', 'utf8'), '//'),
      /rift/i,
    );
  });

  await t.test('a missing projection the host promised is fatal, not silent', () => {
    assert.match(ENTRYPOINT, /ROCKY_MCP_PROJECTION/);
    assert.match(ENTRYPOINT, /process\.exit\(1\)/);
  });
});

test('the host only promises a projection it actually mounted', async () => {
  const gateway = fs.readFileSync('src/openclaw/docker-gateway.mjs', 'utf8');
  const run = gateway.slice(gateway.indexOf('export function buildDockerRunArgs'));
  assert.match(run, /tenantMountSpec\(tenantId\)\.some\(\(m\) => m\.destination === CONTAINER_MCP_PROJECTION\)/);
});

// Live outage 2026-09-22: the embedded node script runs inside a double-quoted
// shell string, so bash expanded `${expectedProjection}` before node saw it and
// `set -u` killed the container with "unbound variable". Every tenant was down.
test('the entrypoint never lets bash expand a JS template literal', async (t) => {
  const lines = ENTRYPOINT.split('\n');
  const start = lines.findIndex((l) => l.includes("node --input-type=module -e"));
  assert.ok(start > 0, 'the embedded node block must exist');

  await t.test('no ${...} survives inside the embedded script', () => {
    const offenders = lines
      .slice(start)
      .map((line, i) => ({ line, n: start + i + 1 }))
      .filter(({ line }) => /\$\{/.test(line));
    assert.deepEqual(
      offenders.map((o) => `${o.n}: ${o.line.trim()}`),
      [],
      'bash expands ${...} in a double-quoted heredoc — use string concatenation',
    );
  });

  await t.test('set -u is on, which is what makes this fatal', () => {
    assert.match(ENTRYPOINT, /set -euo pipefail/);
  });
});
