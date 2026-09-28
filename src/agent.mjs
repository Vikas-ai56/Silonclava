import { matchConnectIntent } from './connect.mjs';
import { createTenantClient } from './tenant-cli/client.mjs';
import { activateTenant, ACTIVATION_STARTED } from './tenant-activation.mjs';

/** One tenant-bound channel turn. All stateful work crosses the tenant command service. */
export async function runAgentTurn(tenant, text, { replyJid, commandText = null } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 'I did not catch that — send another message.';

  const tenantClient = createTenantClient({
    tenantId: tenant.id,
    principal: `whatsapp:${tenant.id}`,
  });
  // Match commands on the user's own words, never on the assembled prompt.
  const said = String(commandText ?? trimmed).trim();
  const connect = matchConnectIntent(said);

  if (connect?.type === 'connect-llm') {
    if (connect.provider !== 'claude') {
      return 'New Codex/API-key connections are disabled. Send “connect claude” instead.';
    }
    try {
      const command = await tenantClient.auth('claude').login({ replyJid: replyJid || tenant.jid });
      return command.result.message;
    } catch (err) {
      // Provider error bodies carry internal detail and help no one here.
      console.warn(`[agent] ${tenant.id}: claude login failed:`, err?.message || err);
      return 'I could not start the Claude login just now. Send *connect claude* again in a moment.';
    }
  }

  const completion = await tenantClient.auth('claude').canComplete(said);
  if (completion.result.pending) {
    try {
      const command = await tenantClient.auth('claude').complete({ code: said });
      // Preparing the workspace outlives this turn, so acknowledge now and
      // announce readiness from the activation itself.
      activateTenant(tenant.id, { to: replyJid || tenant.jid }).catch((err) =>
        console.warn('[agent] activation failed:', err?.message || err),
      );
      return `${command.result.message}\n\n${ACTIVATION_STARTED}`;
    } catch (err) {
      console.warn(`[agent] ${tenant.id}: claude OAuth paste failed:`, err?.message || err);
      return 'That code did not work — they expire quickly.\n\nSend *connect claude* and paste the fresh code.';
    }
  }

  try {
    await tenantClient.mcp().sync({ 'pending-only': true }).catch((err) => {
      console.warn('[agent] pending MCP sync failed:', err?.message || err);
    });
    const command = await tenantClient.runtime().turn(trimmed);
    return command.result.reply;
  } catch (err) {
    console.error('[agent] OpenClaw failed:', err?.message || err);
    return 'I hit a temporary issue reaching my model. Give me a moment and try again.';
  }
}
