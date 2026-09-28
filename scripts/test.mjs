/**
 * Cross-platform test runner — npm's glob in package.json does not expand on Linux CI.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function findTests(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...findTests(p));
    else if (name.endsWith('.test.mjs')) files.push(p);
  }
  return files;
}

const files = findTests('test');
if (files.length === 0) {
  console.error('No test files found under test/');
  process.exit(1);
}

  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
