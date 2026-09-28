import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const TENANTS_DIR = process.env.ROCKY_TENANTS_DIR
  ? path.resolve(process.env.ROCKY_TENANTS_DIR)
  : path.join(ROOT, 'tenants');
export const ORG_DIR = process.env.ROCKY_ORG_DIR
  ? path.resolve(process.env.ROCKY_ORG_DIR)
  : path.join(ROOT, 'org');
export const PLATFORM_DIR = process.env.ROCKY_PLATFORM_DIR
  ? path.resolve(process.env.ROCKY_PLATFORM_DIR)
  : path.join(ROOT, 'platform');
export const TEMPLATE_WORKSPACE = path.join(ORG_DIR, 'templates', 'workspace');
export const PUBLIC_DIR = path.join(ROOT, 'public');
