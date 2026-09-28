import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

/**
 * Load a dotenv-style file into process.env (does not override existing env).
 */
export function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

/**
 * Local machine: `.env.local` (preferred), then legacy `.env`.
 * Production: do not rely on files — set the same keys on the VM/host env.
 * Existing process.env always wins (so prod/platform env overrides files).
 */
export function loadLocalEnv() {
  const local = path.join(ROOT, '.env.local');
  const legacy = path.join(ROOT, '.env');
  const loadedLocal = loadEnvFile(local);
  const loadedLegacy = loadEnvFile(legacy);
  return loadedLocal || loadedLegacy;
}
