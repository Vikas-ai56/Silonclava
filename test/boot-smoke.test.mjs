import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Guards the failure class that shipped undetected: the process bound its port,
 * printed its banner, then died in the listen callback. Every other test in this
 * suite imports modules directly and never starts the gateway, so a boot-time
 * ReferenceError was invisible to all 134 of them.
 */
describe('gateway boot', () => {
  it('starts, serves /health, and shuts down cleanly', async () => {
    const port = 18000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, ['src/index.mjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        ROCKY_CHANNEL: 'mock',
        ROCKY_PROFILE: 'dev',
        ROCKY_API_TOKEN: 'boot-smoke-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (c) => { stderr += String(c); });

    const exited = once(child, 'exit');
    const deadline = Date.now() + 20_000;
    let body = null;

    try {
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Authorization: 'Bearer boot-smoke-token' },
          });
          if (res.ok) { body = await res.json(); break; }
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      assert.equal(child.exitCode, null, `process exited during boot:\n${stderr}`);
      assert.ok(body, 'never served /health');
      assert.equal(body.ok, true);
      assert.doesNotMatch(stderr, /ReferenceError|TypeError|is not defined/);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
