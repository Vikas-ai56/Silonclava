#!/usr/bin/env node
/**
 * Open a tenant's pending Claude authorize URL in the local browser.
 *
 *   ./bin/tenant.mjs auth login --tenant <id>     # starts the session
 *   node scripts/open-claude-login.mjs --tenant <id>
 *
 * The URL is handed straight to the browser and is **never printed**. It is a
 * Connect link, and the same rule that keeps it out of stdout and audit applies
 * to an operator convenience script. Nothing here touches the resulting code:
 * that still goes back through `auth complete` on stdin.
 */
import { execFile } from 'node:child_process';
import { listPendingAuthForTenant } from '../src/tenant-cli/storage/pending-auth.mjs';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const tenantId = arg('--tenant');
if (!tenantId) {
  console.error('usage: node scripts/open-claude-login.mjs --tenant <tenant-id>');
  process.exit(2);
}

const pending = listPendingAuthForTenant('claude', tenantId);
if (!pending.length) {
  console.error(`No pending Claude login for ${tenantId}. Run: ./bin/tenant.mjs auth login --tenant ${tenantId}`);
  process.exit(1);
}

const newest = pending[pending.length - 1];
// The store flattens payload fields onto the record.
const url = newest?.authorizeUrl || newest?.payload?.authorizeUrl;
if (!url) {
  console.error('Pending session has no authorize URL; start the login again.');
  process.exit(1);
}

const opener = process.platform === 'darwin' ? 'open'
  : process.platform === 'win32' ? 'cmd' : 'xdg-open';
const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

execFile(opener, args, (err) => {
  if (err) {
    console.error('Could not open a browser automatically.');
    console.error('Open the tenant paste page instead, then approve there.');
    process.exit(1);
  }
  console.log('');
  console.log('  Opened the Claude approval page in your browser.');
  console.log('  Approve with the DISPOSABLE seat, then copy the CODE#STATE value and run:');
  console.log('');
  console.log(`    printf '%s' 'PASTE_CODE#STATE' | ./bin/tenant.mjs auth complete --tenant ${tenantId}`);
  console.log('');
  console.log('  (the code goes in on stdin; the CLI rejects it in argv)');
  console.log('');
});
