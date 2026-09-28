import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests exercise encrypted tenant vaults without depending on developer secrets.
if (!process.env.ROCKY_VAULT_MASTER_KEY) {
  process.env.ROCKY_VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
}

// The parent test runner sets this before spawning the node:test child, so every
// imported source module resolves TENANTS_DIR to a disposable location.
if (!process.env.ROCKY_TENANTS_DIR) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-test-tenants-'));
  process.env.ROCKY_TENANTS_DIR = root;
  process.once('exit', () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

if (!process.env.ROCKY_PLATFORM_DIR) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-test-platform-'));
  process.env.ROCKY_PLATFORM_DIR = root;
  process.once('exit', () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

// Unit/contract tests exercise the native OpenClaw command boundary without
// depending on a developer-global installation. Live gates invoke the pinned
// package or container explicitly.
if (!process.env.ROCKY_OPENCLAW_BIN) {
  process.env.ROCKY_OPENCLAW_BIN = fileURLToPath(
    new URL('./fixtures/fake-openclaw.mjs', import.meta.url),
  );
}
