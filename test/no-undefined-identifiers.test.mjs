import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Three separate production failures this project has had were the same bug: a
 * module referenced a name it never imported.
 *
 *   markSendStartedUnknown   — swallowed by a try/catch, so `send_started`
 *                              recovery never ran, on crash or clean shutdown
 *   OPENCLAW_LOG_MAX_BYTES   — broke tenant config generation
 *   OPENCLAW_GATEWAY_IDLE_MS — reached a real user as
 *                              "I hit a temporary issue reaching Claude"
 *
 * Unit tests did not catch any of them: the reference sat on a path no test
 * reached, or inside a catch that turned the ReferenceError into a warning.
 * Importing every module is not enough either — a ReferenceError only fires
 * when the line executes.
 *
 * So this checks statically: every SCREAMING_SNAKE_CASE identifier a module
 * reads must be imported, declared, or a known global. That casing convention
 * covers exactly the config-constant family all three bugs came from.
 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const ALLOWED_GLOBALS = new Set([
  'NaN', 'Infinity', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'BigInt',
  'Buffer', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'Intl', 'globalThis', 'process', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'structuredClone', 'queueMicrotask', 'performance', 'crypto',
]);

function declaredNames(src) {
  const names = new Set();
  // import { A, B as C } from '...'  /  import D from '...'  /  import * as E
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from/g)) {
    if (m[1]) names.add(m[1]);
    for (const part of m[2].split(',')) {
      const bound = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (bound) names.add(bound);
    }
  }
  for (const m of src.matchAll(/import\s+([\w$]+)\s+from/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from/g)) names.add(m[1]);
  // const / let / var / function / class declarations, including destructuring
  for (const m of src.matchAll(/(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const bound = part.trim().split(/[:=]/).pop()?.trim();
      if (bound) names.add(bound);
    }
  }
  for (const m of src.matchAll(/function\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/class\s+([\w$]+)/g)) names.add(m[1]);
  return names;
}

function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, (m) =>
      // keep ${...} interpolations, they are real code
      m.replace(/[^${}]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('no undefined config identifiers', () => {
  it('every SCREAMING_SNAKE_CASE name a module reads is imported or declared', () => {
    const offenders = [];
    for (const file of walk('src')) {
      const raw = fs.readFileSync(file, 'utf8');
      const code = stripNonCode(raw);
      const declared = declaredNames(raw);
      const seen = new Set();
      for (const m of code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
        const name = m[1];
        if (seen.has(name) || declared.has(name) || ALLOWED_GLOBALS.has(name)) continue;
        // property access (obj.CONST) and object keys (CONST:) are not reads
        const at = m.index ?? 0;
        if (code[at - 1] === '.') continue;
        if (/^\s*:/.test(code.slice(at + name.length))) continue;
        seen.add(name);
        offenders.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these names are read but never imported or declared:\n  ${offenders.join('\n  ')}`,
    );
  });
});
