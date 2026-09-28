import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ORG_DIR } from '../src/paths.mjs';

const execFileAsync = promisify(execFile);
const connectorImage = 'rocky-composio-connector:test';
const postgresImage = 'postgres:17-alpine';
const suffix = `${process.pid}-${Date.now()}`;
const network = `rocky-connector-smoke-${suffix}`;
const postgres = `rocky-connector-pg-${suffix}`;
const connector = `rocky-connector-api-${suffix}`;
let secretDirectory = null;

async function docker(args, timeout = 60_000) {
  return execFileAsync('docker', args, { windowsHide: true, timeout });
}

async function imageExists(image) {
  try {
    const { stdout } = await docker(['images', '-q', image], 15_000);
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

async function waitFor(command, attempts = 40) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await command();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Docker service did not become ready');
}

function connectorArgs(apiKeyPath, publicKeyPath) {
  return [
    'run', '-d', '--rm', '--name', connector, '--network', network,
    '-e', 'CONNECTOR_DATABASE_URL=postgresql://rocky_connector:test@postgres:5432/rocky_connector',
    '-e', 'CONNECTOR_COMPOSIO_API_KEY_FILE=/run/secrets/composio-project-key',
    '-e', 'CONNECTOR_SERVICE_PUBLIC_KEY_FILE=/run/secrets/rocky-assertion-public.pem',
    '-e', 'CONNECTOR_REGISTRY_PATH=/org/mcp/registry.json',
    '-e', 'CONNECTOR_ENTERPRISE_ORG_ID=smoke-org',
    '--network-alias', 'connector',
    '-v', `${apiKeyPath}:/run/secrets/composio-project-key:ro`,
    '-v', `${publicKeyPath}:/run/secrets/rocky-assertion-public.pem:ro`,
    '-v', `${path.join(ORG_DIR, 'mcp', 'registry.json')}:/org/mcp/registry.json:ro`,
    connectorImage,
  ];
}

async function startAndVerifyConnector(apiKeyPath, publicKeyPath) {
  await docker(connectorArgs(apiKeyPath, publicKeyPath), 120_000);
  await waitFor(() => docker([
    'exec', connector, 'python', '-c',
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4317/health', timeout=2)",
  ]));
}

describe('Composio connector Docker smoke', () => {
  after(async () => {
    await docker(['rm', '-f', connector]).catch(() => {});
    await docker(['rm', '-f', postgres]).catch(() => {});
    await docker(['network', 'rm', network]).catch(() => {});
    if (secretDirectory) await fs.rm(secretDirectory, { recursive: true, force: true });
  });

  it('boots against Postgres and survives sidecar recreation', { timeout: 120_000 }, async (t) => {
    if (!(await imageExists(connectorImage)) || !(await imageExists(postgresImage))) {
      t.skip('Connector or Postgres Docker image is unavailable');
      return;
    }

    secretDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rocky-connector-secrets-'));
    const apiKeyPath = path.join(secretDirectory, 'project-key');
    const publicKeyPath = path.join(secretDirectory, 'assertion-public.pem');
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await fs.writeFile(apiKeyPath, 'smoke-project-key\n', { mode: 0o600 });
    await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), {
      mode: 0o600,
    });

    await docker(['network', 'create', network]);
    await docker([
      'run', '-d', '--rm', '--name', postgres, '--network', network,
      '--network-alias', 'postgres',
      '-e', 'POSTGRES_PASSWORD=test',
      '-e', 'POSTGRES_USER=rocky_connector',
      '-e', 'POSTGRES_DB=rocky_connector',
      postgresImage,
    ], 120_000);
    await waitFor(() => docker([
      'exec', postgres, 'pg_isready', '-U', 'rocky_connector', '-d', 'rocky_connector',
    ]));

    await startAndVerifyConnector(apiKeyPath, publicKeyPath);
    const tables = await docker([
      'exec', postgres, 'psql', '-U', 'rocky_connector', '-d', 'rocky_connector', '-At',
      '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    ]);
    assert.match(tables.stdout, /connector_audit/);
    assert.match(tables.stdout, /connector_idempotency/);

    await docker(['stop', connector]);
    await startAndVerifyConnector(apiKeyPath, publicKeyPath);
  });
});
