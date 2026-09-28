import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { TEMPLATE_WORKSPACE } from './paths.mjs';
import { claimTenantIdentity, tenantDir, saveTenant } from './tenants.mjs';
import { ensureTenantOpenclaw } from './openclaw/tenant-openclaw.mjs';
import { ensureTenantCliHome } from './cli-home.mjs';
import { verifyOrgBundle } from './mcp/org-bundle.mjs';

async function copyDir(src, dest, copied = new Set()) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, copied);
    } else {
      try {
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
        copied.add(to);
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
  }
  return copied;
}

/** Strip markdown / control chars so names cannot inject agent instructions. */
export function sanitizeDisplayName(raw) {
  let s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[#*_`>[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || 'User';
}

async function renderWorkspaceTemplate(workspacePath, values, copied) {
  const replacements = {
    '{{NAME}}': values.name,
    '{{PLAN}}': values.plan,
    '{{EMAIL_LINE}}': values.email ? `- **Email:** ${values.email}` : '',
  };
  for (const fileName of ['IDENTITY.md', 'USER.md']) {
    const target = path.join(workspacePath, fileName);
    if (!copied.has(target)) continue;
    let contents = await fs.readFile(target, 'utf8');
    for (const [token, value] of Object.entries(replacements)) {
      contents = contents.replaceAll(token, value);
    }
    await fs.writeFile(target, contents, { mode: 0o600 });
  }
}

/**
 * Create an isolated tenant workspace + project-local OpenClaw state dir.
 */
export async function provisionTenant({
  id: requestedId = null,
  phone,
  jid,
  name,
  plan,
  email = null,
  finalState = 'ACTIVE',
}) {
  const safeName = sanitizeDisplayName(name);
  const safeEmail = email
    ? String(email).replace(/[\r\n#*_`]/g, '').slice(0, 120)
    : null;
  const orgBundle = await verifyOrgBundle();
  if (!orgBundle.ok) {
    throw new Error(`Organization bundle verification failed: ${orgBundle.errors.join('; ')}`);
  }
  const identity = await claimTenantIdentity({
    phone,
    jid,
    requestedId,
    defaults: {
      name: safeName,
      email,
      plan,
      state: 'PROVISION',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  const id = identity.id;
  const dir = tenantDir(id);
  const workspacePath = path.join(dir, 'workspace');
  const openclawStateDir = path.join(dir, 'openclaw');

  await fs.mkdir(path.join(dir, 'vault'), { recursive: true });
  await fs.mkdir(openclawStateDir, { recursive: true });
  const copiedWorkspaceFiles = await copyDir(TEMPLATE_WORKSPACE, workspacePath);
  await renderWorkspaceTemplate(workspacePath, {
    name: safeName,
    plan: String(plan || 'claude'),
    email: safeEmail,
  }, copiedWorkspaceFiles);

  const draft = { id, phone, jid, name: safeName, email, plan };
  const cli = await ensureTenantCliHome(draft);

  const now = new Date().toISOString();
  const tenant = {
    ...identity,
    id,
    phone,
    jid,
    name: safeName,
    email,
    plan, // 'claude' | 'codex'
    state: finalState,
    workspacePath,
    vaultPath: path.join(dir, 'vault'),
    openclawStateDir,
    openclawConfigPath: path.join(openclawStateDir, 'openclaw.json'),
    cliHomePath: cli.home,
    claudeConfigDir: cli.claudeDir,
    codexHomePath: cli.codexDir,
    orgBundleVersion: orgBundle.version,
    createdAt: identity.createdAt || now,
    updatedAt: now,
  };

  await ensureTenantOpenclaw(tenant);
  await saveTenant(tenant);
  return tenant;
}
