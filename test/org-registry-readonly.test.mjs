import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Guards the read-only enforcement that total re-execution depends on
 * (DECISIONS.md "Tool surface" / "Write-tool gate"; SPEC-phase3c §6).
 *
 * Uses a throwaway ROCKY_ORG_DIR so the versioned org bundle and its hash
 * manifest are never written to. `paths.mjs` resolves ORG_DIR once at import
 * time, so the fixture directory is created before the first import and reused
 * for every case; only the registry contents change.
 */
let fixtureDir;
let registryPath;
let prevOrgDir;

before(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-org-fixture-'));
  registryPath = path.join(fixtureDir, 'mcp', 'registry.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  prevOrgDir = process.env.ROCKY_ORG_DIR;
  process.env.ROCKY_ORG_DIR = fixtureDir;
});

after(async () => {
  if (prevOrgDir === undefined) delete process.env.ROCKY_ORG_DIR;
  else process.env.ROCKY_ORG_DIR = prevOrgDir;
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function readRegistry(toolkits) {
  await fs.writeFile(
    registryPath,
    JSON.stringify({ schemaVersion: 2, provider: 'composio', toolkits }),
  );
  const url = new URL('../src/mcp/org-bundle.mjs', import.meta.url);
  url.searchParams.set('v', `${Date.now()}${Math.random()}`);
  const mod = await import(url.href);
  return await mod.readOrgMcpRegistry();
}

describe('org MCP registry read-only enforcement', () => {
  it('rejects an enabled toolkit with no toolFilter.include', async () => {
    await assert.rejects(
      readRegistry({ gmail: { enabled: true } }),
      /without a read-only toolFilter\.include/,
    );
  });

  it('rejects an empty include-list', async () => {
    await assert.rejects(
      readRegistry({ gmail: { enabled: true, toolFilter: { include: [] } } }),
      /without a read-only toolFilter\.include/,
    );
  });

  it('rejects a malformed include entry', async () => {
    await assert.rejects(
      readRegistry({
        gmail: { enabled: true, toolFilter: { include: ['GMAIL_FETCH_EMAILS', ''] } },
      }),
      /invalid toolFilter\.include entry/,
    );
  });

  it('still rejects runtime material in the org bundle', async () => {
    await assert.rejects(
      readRegistry({
        gmail: { enabled: true, toolFilter: { include: ['GMAIL_FETCH_EMAILS'] }, headers: {} },
      }),
      /forbidden MCP runtime configuration/,
    );
  });

  it('accepts an explicit access: "full" opt-in', async () => {
    const registry = await readRegistry({
      gmail: { enabled: true, access: 'full' },
    });
    assert.equal(registry.toolkits.gmail.access, 'full');
  });

  it('rejects setting both access: "full" and a filter', async () => {
    await assert.rejects(
      readRegistry({
        gmail: { enabled: true, access: 'full', toolFilter: { include: ['GMAIL_FETCH_EMAILS'] } },
      }),
      /pick one/,
    );
  });

  it('accepts a disabled toolkit without a filter, and a filtered enabled one', async () => {
    const registry = await readRegistry({
      outlook: { enabled: false },
      gmail: { enabled: true, toolFilter: { include: ['GMAIL_FETCH_EMAILS'] } },
    });
    assert.deepEqual(registry.toolkits.gmail.toolFilter.include, ['GMAIL_FETCH_EMAILS']);
  });
});
