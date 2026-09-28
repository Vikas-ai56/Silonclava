import crypto from 'node:crypto';
import fs from 'node:fs';
import { readGatewayMeta, writeGatewayMeta, ensureMountAccess, containerMountsIntact } from './docker-gateway.mjs';
import { tenantDir } from '../tenants.mjs';
import { composioRuntimeProjectionPath } from '../mcp/composio-runtime.mjs';
import { ensureWorkspaceGuardrails, verifyWorkspaceGuardrails } from '../workspace-guardrails.mjs';

export const PHASE = {
  CREATE: 'create',
  WAKE: 'wake',
};

export async function ensureAgentCredential(tenantId) {
  const meta = (await readGatewayMeta(tenantId)) || {};
  if (typeof meta.agentToken === 'string' && meta.agentToken.length >= 32) {
    return { token: meta.agentToken, minted: false };
  }
  const token = crypto.randomBytes(32).toString('hex');
  await writeGatewayMeta(tenantId, { ...meta, agentToken: token, updatedAt: new Date().toISOString() });
  return { token, minted: true };
}

function step(name, phases, run, { required = true } = {}) {
  return { name, phases, run, required };
}

export const ONBOARDING_STEPS = [
  step('tenant directory exists', [PHASE.CREATE, PHASE.WAKE], async ({ tenantId }) => {
    if (!fs.existsSync(tenantDir(tenantId))) throw new Error('tenant directory is missing');
    return 'present';
  }),

  step('agent credential', [PHASE.CREATE, PHASE.WAKE], async ({ tenantId, state }) => {
    const { token, minted } = await ensureAgentCredential(tenantId);
    state.agentToken = token;
    return minted ? 'minted' : 'reused';
  }),

  step('workspace guardrails', [PHASE.CREATE, PHASE.WAKE], async ({ tenantId, state }) => {
    const { version, changed } = ensureWorkspaceGuardrails(tenantId);
    const check = verifyWorkspaceGuardrails(tenantId);
    if (!check.ok) throw new Error(`guardrails missing after write: ${check.missing.join(', ')}`);
    state.guardrailHash = check.hash;
    return `${version} ${changed.length ? `rewrote ${changed.join(', ')}` : 'current'} (${check.hash})`;
  }),

  step('container can read the tenant mounts', [PHASE.CREATE, PHASE.WAKE], async ({ tenantId }) => {
    const { gid, touched } = await ensureMountAccess(tenantId);
    if (!Number.isInteger(gid)) throw new Error('could not resolve the image uid/gid');
    return `gid ${gid}, ${touched} path(s)`;
  }),

  step('mcp projection present', [PHASE.WAKE], async ({ tenantId, rehydrateProjection }) => {
    const file = composioRuntimeProjectionPath(tenantId);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return 'present';
    if (typeof rehydrateProjection !== 'function') return 'no projection for this tenant';
    await rehydrateProjection(tenantId);
    return fs.existsSync(file) ? 'rewritten' : 'not required';
  }, { required: false }),

  step('bind-mount sources still exist', [PHASE.WAKE], async ({ containerName }) => {
    const { intact, missing } = await containerMountsIntact(containerName);
    if (!intact) throw new Error(`mount source gone: ${missing.join(', ')}`);
    return 'intact';
  }),
];

export function stepsForPhase(phase) {
  return ONBOARDING_STEPS.filter((s) => s.phases.includes(phase));
}

/**
 * @returns {Promise<{ok: boolean, phase: string, state: object, results: Array}>}
 */
export async function runTenantOnboarding(phase, context) {
  const state = {};
  const results = [];
  for (const s of stepsForPhase(phase)) {
    try {
      const detail = await s.run({ ...context, state });
      results.push({ name: s.name, ok: true, detail });
    } catch (err) {
      const detail = String(err?.message || err);
      results.push({ name: s.name, ok: false, detail });
      if (s.required) {
        console.warn(
          `[onboarding] ${context.tenantId}: ${phase} failed at "${s.name}" — ${detail}`,
        );
        return { ok: false, phase, state, results };
      }
    }
  }
  const summary = results.map((r) => `${r.name}=${r.ok ? 'ok' : 'FAILED'}`).join(' ');
  console.log(`[onboarding] ${context.tenantId}: ${phase} ${summary}`);
  return { ok: true, phase, state, results };
}
