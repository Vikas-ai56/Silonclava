import { spawn } from 'node:child_process';
import {
  ensureTenantOpenclaw,
  resolveOpenclawSpawn,
  withTenantOpenclawConfigLock,
} from '../openclaw/tenant-openclaw.mjs';
import { tenantCliEnv } from '../cli-home.mjs';
import { stripAnthropicStaticEnv } from '../tenant-cli/runtime-credentials.mjs';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function parseJsonOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nativeMcpEnv(tenant, context) {
  return stripAnthropicStaticEnv({
    ...process.env,
    ...tenantCliEnv(tenant),
    OPENCLAW_STATE_DIR: context.stateDir,
    OPENCLAW_CONFIG_PATH: context.configPath,
    OPENCLAW_WORKSPACE_DIR: context.workspace,
    OPENCLAW_HOME: context.stateDir,
  });
}

function spawnNativeMcp(tenant, context, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const { command, argsPrefix, useShell } = resolveOpenclawSpawn();
    if (useShell) {
      reject(new Error('Native MCP management requires an executable OPENCLAW_BIN path; shell invocation is disabled'));
      return;
    }
    const child = spawn(command, [...argsPrefix, 'mcp', ...args], {
      cwd: context.workspace,
      env: nativeMcpEnv(tenant, context),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(reject, new Error('OpenClaw MCP command exceeded the output limit'));
      }
      return next;
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`OpenClaw MCP command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `OpenClaw MCP command exited ${code}`;
        finish(reject, new Error(message));
        return;
      }
      finish(resolve, {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        json: parseJsonOutput(stdout),
      });
    });
  });
}

/**
 * Run OpenClaw's own MCP management command in exactly one tenant's state.
 * This wrapper does not implement the MCP protocol, OAuth exchange, or tools.
 */
export async function runNativeMcpCommand(tenant, args, options = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Native MCP arguments must be a string array');
  }
  if (args.includes('--code')) {
    throw new Error('MCP authorization codes cannot be passed through argv');
  }
  const context = await ensureTenantOpenclaw(tenant);
  return withTenantOpenclawConfigLock(
    tenant.id,
    () => spawnNativeMcp(tenant, context, args, options),
    { waitMs: options.lockWaitMs || Math.max(65_000, Number(options.timeoutMs || 60_000) + 5_000) },
  );
}

export function authorizationUrlFromOutput(output) {
  const match = String(output || '').match(/https:\/\/[^\s]+/i);
  return match ? match[0] : null;
}
