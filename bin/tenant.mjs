#!/usr/bin/env node
import { executeTenantCommand } from '../src/tenant-cli/index.mjs';
import { redactParams } from '../src/tenant-cli/audit.mjs';
import { projectTenantCommandForStdout } from '../src/tenant-cli/result.mjs';

async function readStdin(label) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks).toString('utf8').trim();
  if (!input) throw new Error(`No ${label} received on stdin`);
  return input;
}

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => /^--(?:code|state)(?:=|$)/.test(arg))) {
    throw new Error('Do not pass authorization codes or OAuth state in argv; pipe the code to stdin and include state in the same payload');
  }
  if (args[1] === 'complete' && args[0] === 'auth') {
    if (process.stdin.isTTY) {
      throw new Error('Pipe OAuth completion data to stdin');
    }
    const input = await readStdin('OAuth completion data');
    args.push('--code', input);
  }
  if (args[0] === 'mcp' && args[1] === 'configure') {
    if (process.stdin.isTTY) throw new Error('Pipe the Composio project key to stdin');
    const input = await readStdin('Composio project key');
    args.push('--secret', input);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const result = await executeTenantCommand(args, {
    authorization: { kind: 'operator', principal: `local-uid:${uid}` },
  });
  const output = projectTenantCommandForStdout(result);
  process.stdout.write(`${JSON.stringify(output, null, args.includes('--json') ? 0 : 2)}\n`);
} catch (err) {
  const safe = redactParams({ message: String(err?.message || err) }).message;
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
