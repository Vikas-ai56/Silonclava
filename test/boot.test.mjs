import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The suite imports modules, never the application. Two ReferenceErrors
 * reached production on 2026-09-21 with every test green — a missing import in
 * src/index.mjs crash-looped the gateway 626 times. Boot the real entrypoint.
 */
const ENTRYPOINTS = new Set(['index.mjs', 'cli-mock.mjs']);

describe('the application boots', () => {
  // Boot the provider path, not the mock path: the mock branch returns before
  // the adapter is built, so it never executed the line that crash-looped prod.
  it('starts src/index.mjs on the real provider path and reports ready', async () => {
    const out = await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        ['src/index.mjs'],
        {
          timeout: 25_000,
          env: {
            ...process.env,
            ROCKY_VAULT_MASTER_KEY: 'a'.repeat(64),
            ROCKY_PROFILE: 'dev',
            ROCKY_CHANNEL: 'twilio',
            TWILIO_ACCOUNT_SID: 'ACtest',
            TWILIO_AUTH_TOKEN: 'token-for-boot-only',
            TWILIO_WHATSAPP_FROM: '+10000000000',
            ROCKY_PUBLIC_BASE_URL: 'https://boot.test',
            PORT: '8991',
          },
        },
        (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
      );
      // Ready or dead, we know within a few seconds.
      setTimeout(() => child.kill('SIGTERM'), 6_000);
    });

    assert.doesNotMatch(out, /ReferenceError|TypeError|SyntaxError|is not defined/, out.slice(0, 500));
    assert.match(out, /gateway \(twilio\)/, `no ready line:\n${out.slice(0, 500)}`);
  });

  it('every module under src/ imports cleanly', async () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        // Entrypoints run on import (they parse argv and exit); the boot test
        // above covers those.
        else if (e.name.endsWith('.mjs') && !ENTRYPOINTS.has(e.name)) files.push(full);
      }
    })('src');

    const failed = [];
    for (const f of files) {
      try {
        await import(path.resolve(f));
      } catch (err) {
        failed.push(`${f}: ${String(err?.message || err).slice(0, 90)}`);
      }
    }
    assert.deepEqual(failed, [], `modules failed to import:\n${failed.join('\n')}`);
  });
});
