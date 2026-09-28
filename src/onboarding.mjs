import {
  claimTenantIdentity,
  findTenantByJid,
  findTenantByPhone,
  saveTenant,
} from './tenants.mjs';
import { provisionTenant } from './provision.mjs';
import { normalizePhone } from './phone.mjs';
import { runAgentTurn } from './agent.mjs';
import { isOperatorPhone, OPERATOR_NAME, isAllowedPhone } from './config.mjs';
import { withTyping } from './typing.mjs';

const PLAN_ALIASES = {
  claude: 'claude',
  anthropic: 'claude',
};

function asksForUnsupportedPlan(text) {
  return /\b(codex|openai|chatgpt)\b/i.test(String(text || ''));
}

function detectPlan(text) {
  const t = text.trim().toLowerCase();
  for (const [key, plan] of Object.entries(PLAN_ALIASES)) {
    if (t === key || t.includes(key)) return plan;
  }
  return null;
}

function phoneFromJid(jid) {
  return String(jid).replace(/@.*$/, '').split(':')[0].replace(/\D/g, '');
}

/** Prefer real WhatsApp phone JID when Baileys also sends a LID. */
export function resolveSender({ from, phoneJid }) {
  if (phoneJid && String(phoneJid).includes('@s.whatsapp.net')) {
    return String(phoneJid);
  }
  if (from && String(from).includes('@s.whatsapp.net')) {
    return String(from);
  }
  // Fall back to whatever we got (may be @lid — operator match may still work via raw)
  return String(from || '');
}

async function bootstrapOperator(jid, phone) {
  const tenant = await provisionTenant({
    phone,
    jid,
    name: OPERATOR_NAME,
    plan: 'claude',
    email: null,
    finalState: 'AUTH_PENDING',
  });
  tenant.role = 'operator';
  tenant.updatedAt = new Date().toISOString();
  await saveTenant(tenant);
  return tenant;
}

/**
 * Resolve an inbound sender to a tenant *before* anything is enqueued or
 * persisted (SPEC-phase3c §5).
 *
 * The allow-list is checked before any tenant data is created, and an
 * allow-listed new sender is claimed atomically, so the scheduler always has a
 * real `tenant.id` to key its lane on. Phone and JID forms are aliases of the
 * same tenant and must never open separate lanes.
 *
 * @returns {{ok: false, reason: string} | {ok: true, tenant: object, jid: string,
 *            phone: string, isNewOperator: boolean, isNewTenant: boolean}}
 */
export async function resolveInboundSender(msg) {
  const jid = resolveSender(msg);
  const phone = phoneFromJid(jid) || phoneFromJid(msg.phoneJid) || phoneFromJid(msg.from);

  // Closed allowlist: ignore strangers before any tenant data exists.
  if (!isAllowedPhone(phone) && !isAllowedPhone(msg.from) && !isAllowedPhone(jid)) {
    console.log(`[onboarding] ignored non-allowlisted sender ${phone || jid || msg.from}`);
    return { ok: false, reason: 'not_allowlisted' };
  }

  let tenant = await findTenantByJid(jid);
  if (!tenant && phone) tenant = await findTenantByPhone(phone);
  if (tenant) {
    return { ok: true, tenant, jid, phone, isNewOperator: false, isNewTenant: false };
  }

  if (isOperatorPhone(phone) || isOperatorPhone(msg.from)) {
    const opJid = jid.includes('@s.whatsapp.net') ? jid : `${phone}@s.whatsapp.net`;
    const operator = await bootstrapOperator(opJid, phone || phoneFromJid(opJid));
    console.log(`[onboarding] operator bootstrap ${operator.phone} → AUTH_PENDING (${operator.plan})`);
    return { ok: true, tenant: operator, jid, phone, isNewOperator: true, isNewTenant: true };
  }

  const claimed = await claimTenantIdentity({
    phone: phone || phoneFromJid(jid),
    jid,
    defaults: {
      name: null,
      email: null,
      plan: null,
      state: 'NEW',
      workspacePath: null,
      vaultPath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  return { ok: true, tenant: claimed, jid, phone, isNewOperator: false, isNewTenant: true };
}

/**
 * WhatsApp-side onboarding for unknown JIDs (when someone texts before/without web signup).
 * Allowlisted operators skip plan questions and go straight to Claude CLI.
 *
 * `resolved` comes from `resolveInboundSender`. It is required: resolution must
 * already have happened before the message was enqueued (§5).
 */
export async function handleInbound(channel, msg, resolved) {
  // The user's own words. `msg.text` carries the assembled model prompt —
  // preambles and replayed context — so reading it captured our audience rule
  // as a tenant's name. Commands and onboarding answers use this instead.
  const said = String(msg.commandText ?? msg.text ?? '').trim();

  if (!resolved || !resolved.ok) {
    throw new Error('handleInbound requires a resolved sender; call resolveInboundSender first');
  }
  const { jid, phone, isNewOperator, isNewTenant } = resolved;
  let tenant = resolved.tenant;

  // Operator fast-path skips profile questions, but not tenant-owned Claude login.
  if (isNewOperator) {
    const opJid = jid.includes('@s.whatsapp.net') ? jid : `${phone}@s.whatsapp.net`;
    const replyTo = msg.chatJid || (String(msg.from || '').includes('@') ? msg.from : opJid);
    const reply = await withTyping(channel, replyTo, () =>
      runAgentTurn(tenant, 'connect claude', { replyJid: replyTo }),
    );
    await channel.sendText(replyTo, reply);
    return { tenant, state: 'AUTH_PENDING' };
  }

  if (isNewTenant) {
    await channel.sendText(
      jid,
      'Welcome to Rocky.\n\nReply with your name, or finish signup at /signup on the web.\n' +
        'This migration uses Claude subscription login; you can also reply: claude',
    );
    return { tenant, state: 'NEW' };
  }

  if (tenant.state === 'NEW') {
    if (asksForUnsupportedPlan(said)) {
      await channel.sendText(jid, 'New Codex/API-key onboarding is disabled. Reply claude to continue.');
      return { tenant, state: 'NEW' };
    }
    const plan = detectPlan(said);
    if (plan) {
      tenant.plan = plan;
      tenant.state = 'COLLECT_PLAN';
      tenant.updatedAt = new Date().toISOString();
      await saveTenant(tenant);
      await channel.sendText(
        jid,
        `Locked in ${plan}. What should I call you? (reply with your name)`,
      );
      return { tenant, state: 'COLLECT_PLAN' };
    }

    const name = said;
    if (name.length >= 2 && !detectPlan(name)) {
      tenant.name = name;
      tenant.state = 'COLLECT_PLAN';
      tenant.updatedAt = new Date().toISOString();
      await saveTenant(tenant);
      await channel.sendText(
        jid,
        `Nice to meet you, ${name}. Reply claude to connect your subscription.`,
      );
      return { tenant, state: 'COLLECT_PLAN' };
    }

    await channel.sendText(jid, 'Send your name, or reply claude to choose the supported plan.');
    return { tenant, state: 'NEW' };
  }

  if (tenant.state === 'COLLECT_PLAN') {
    if (!tenant.plan) {
      if (asksForUnsupportedPlan(said)) {
        await channel.sendText(jid, 'New Codex/API-key onboarding is disabled. Please reply claude.');
        return { tenant, state: 'COLLECT_PLAN' };
      }
      const plan = detectPlan(said);
      if (!plan) {
        await channel.sendText(jid, 'Please reply with claude.');
        return { tenant, state: 'COLLECT_PLAN' };
      }
      tenant.plan = plan;
    } else if (!tenant.name) {
      tenant.name = said || 'Operator';
    }

    if (tenant.plan && tenant.name) {
      tenant.state = 'PROVISION';
      tenant.updatedAt = new Date().toISOString();
      await saveTenant(tenant);

      const provisioned = await provisionTenant({
        id: tenant.id,
        phone: tenant.phone,
        jid: tenant.jid,
        name: tenant.name,
        plan: tenant.plan,
        email: tenant.email,
        finalState: 'AUTH_PENDING',
      });

      const login = await runAgentTurn(provisioned, 'connect claude', { replyJid: jid });
      await channel.sendText(
        jid,
        `Workspace ready, ${provisioned.name}. Claude login is required before tasks can run.\n\n${login}`,
      );
      return { tenant: provisioned, state: 'AUTH_PENDING' };
    }

    tenant.updatedAt = new Date().toISOString();
    await saveTenant(tenant);
    await channel.sendText(jid, 'Almost there — I still need your name and the claude plan.');
    return { tenant, state: 'COLLECT_PLAN' };
  }

  if (tenant.state === 'PROVISION') {
    const provisioned = await provisionTenant({
      id: tenant.id,
      phone: tenant.phone,
      jid: tenant.jid,
      name: tenant.name || 'Operator',
      plan: tenant.plan || 'claude',
      email: tenant.email,
      finalState: 'AUTH_PENDING',
    });
    const login = await runAgentTurn(provisioned, 'connect claude', { replyJid: jid });
    await channel.sendText(jid, `Workspace recovered. Claude login is still required.\n\n${login}`);
    return { tenant: provisioned, state: 'AUTH_PENDING' };
  }

  if (tenant.state === 'AUTH_PENDING') {
    const replyTo = msg.chatJid || msg.from || jid;
    const oauthMessage =
      /^(connect|link)\s+(claude|anthropic)\b/i.test(said) || said.includes('#')
        ? said
        : 'connect claude';
    const reply = await withTyping(channel, replyTo, () =>
      runAgentTurn(tenant, oauthMessage, { replyJid: replyTo }),
    );
    const refreshed = await findTenantByPhone(tenant.phone);
    await channel.sendText(replyTo, reply);
    return {
      tenant: refreshed || tenant,
      state: refreshed?.state === 'ACTIVE' ? 'ACTIVE' : 'AUTH_PENDING',
    };
  }

  // ACTIVE — typing for every user while OpenClaw works
  // Prefer the real WhatsApp chat JID (LID self-chat) so replies decrypt on the phone.
  const replyTo = msg.chatJid || msg.from || jid;
  const reply = await withTyping(channel, replyTo, () =>
    runAgentTurn(tenant, msg.text, { replyJid: replyTo, commandText: msg.commandText }),
  );
  await channel.sendText(replyTo, reply);
  return { tenant, state: 'ACTIVE' };
}

/** Web signup provisions the workspace; Claude login is still mandatory. */
export async function signupFromWeb({ name, phone, plan, email }) {
  const normalized = normalizePhone(phone);
  const planKey = detectPlan(plan);
  if (!planKey) throw new Error('Choose claude; new Codex/API-key onboarding is disabled');
  if (!name || String(name).trim().length < 2) throw new Error('Enter your name');

  const existing = await findTenantByJid(normalized.jid);
  if (existing && ['ACTIVE', 'AUTH_PENDING'].includes(existing.state)) {
    return { tenant: existing, created: false };
  }

  const tenant = await provisionTenant({
    id: existing?.id || null,
    phone: normalized.phone,
    jid: normalized.jid,
    name: String(name).trim(),
    plan: planKey,
    email: email ? String(email).trim() : null,
    finalState: 'AUTH_PENDING',
  });

  return { tenant, created: true };
}
