import { ensureWorkspaceGuardrails, verifyWorkspaceGuardrails } from './workspace-guardrails.mjs';
import { toWhatsAppText } from './whatsapp-format.mjs';

export const ACTIVATION_STARTED =
  'Setting up your workspace — give me a moment. I will message you when it is ready.';

export function readyMessage() {
  return toWhatsAppText(
    [
      '*You are ready to go.*',
      '',
      'I am set up as a BugleRock assistant by default. If you would rather I worked',
      'a different way, say *set up my persona* and I will walk you through it.',
    ].join('\n'),
  );
}

let delivery = { channel: null, recipientFor: null };

export function configureActivationDelivery({ channel, recipientFor }) {
  delivery = { channel, recipientFor };
}

const inFlight = new Map();

export function whenActivated(tenantId) {
  return inFlight.get(tenantId) || null;
}

export function activateTenant(tenantId, { to = null } = {}) {
  const existing = inFlight.get(tenantId);
  if (existing) return existing;

  const run = (async () => {
    let ok = true;
    try {
      ensureWorkspaceGuardrails(tenantId);
      const check = verifyWorkspaceGuardrails(tenantId);
      ok = check.ok;
      if (!ok) console.warn(`[activation] ${tenantId}: guardrails missing — ${check.missing.join(', ')}`);
    } catch (err) {
      ok = false;
      console.warn(`[activation] ${tenantId}: workspace setup failed — ${err?.message || err}`);
    }

    const recipient = to || delivery.recipientFor?.(tenantId);
    if (recipient && typeof delivery.channel?.sendText === 'function') {
      const text = ok
        ? readyMessage()
        : toWhatsAppText('Setup did not finish cleanly. I can still talk, but some things may not work yet.');
      await delivery.channel.sendText(recipient, text).catch((err) => {
        console.warn(`[activation] ${tenantId}: could not announce readiness — ${err?.message || err}`);
      });
    }
    return { ok };
  })().finally(() => inFlight.delete(tenantId));

  inFlight.set(tenantId, run);
  return run;
}
