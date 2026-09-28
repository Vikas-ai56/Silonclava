/**
 * Single-instance starter for Rocky.
 * Kills any previous `src/index.mjs` before boot so two gateways never race.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ROOT } from '../src/paths.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(ROOT, 'src', 'index.mjs');
const PORT = Number(process.env.PORT || process.env.ROCKY_PORT || 8787);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listRockyPids() {
  const found = new Set();

  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
            `Where-Object { $_.CommandLine -match 'src[/\\\\]index\\.mjs' } | ` +
            `ForEach-Object { $_.ProcessId }`,
        ],
        { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
      );
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const pid = Number(String(line).trim());
        if (pid && pid !== process.pid) found.add(pid);
      }
    } else {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='], {
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of String(stdout || '').split('\n')) {
        if (!/src\/index\.mjs/.test(line)) continue;
        const pid = Number(String(line).trim().split(/\s+/)[0]);
        if (pid && pid !== process.pid) found.add(pid);
      }
    }
  } catch (err) {
    console.warn('[start] process scan failed:', err?.message || err);
  }

  return [...found];
}

async function killPid(pid) {
  if (!pidAlive(pid)) return;
  console.log(`[start] stopping previous Rocky process pid=${pid}`);
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      }).catch(() => {});
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
      // Wait for the configured graceful-shutdown grace period before SIGKILL.
      // 400ms was not remotely sufficient: SIGTERM starts a drain that waits for
      // active turns and their delivery commits (SPEC-phase3c §8), and killing
      // through that loses exactly the work the drain exists to protect.
      const graceMs = Number(process.env.ROCKY_SHUTDOWN_GRACE_MS || 20_000);
      const deadline = Date.now() + graceMs + 2_000;
      while (pidAlive(pid) && Date.now() < deadline) {
        await sleep(200);
      }
      if (pidAlive(pid)) {
        console.warn(`[start] pid=${pid} did not exit within ${graceMs}ms — SIGKILL`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.warn(`[start] kill ${pid} failed:`, err?.message || err);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function waitUntilClear({ timeoutMs = 12_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const left = (await listRockyPids()).filter((p) => pidAlive(p));
    const free = await portFree(PORT);
    if (!left.length && free) return true;
    await sleep(300);
  }
  return false;
}

async function ensureSingleInstance() {
  const victims = await listRockyPids();
  for (const pid of victims) await killPid(pid);

  const ok = await waitUntilClear();
  if (!ok) {
    const still = await listRockyPids();
    throw new Error(
      `Could not free previous Rocky instance (still running: ${still.join(', ') || 'unknown'}; port ${PORT} busy). ` +
        `Kill it manually, then retry.`,
    );
  }
}

const watch = process.argv.includes('--watch');

await ensureSingleInstance();
console.log(`[start] launching Rocky${watch ? ' (--watch)' : ''}…`);

if (watch) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--watch', INDEX], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  await import(pathToFileURL(INDEX).href);
}
