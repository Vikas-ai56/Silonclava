import { decryptBody } from './store.mjs';
import { transcriptLine } from './transcript-label.mjs';


export function quotedMessage(store, conversationId, replyToExternalId) {
  if (!replyToExternalId) return null;
  // A long reply is delivered as several provider messages. `messages` holds
  // the whole reply; `message_parts` maps each delivered part back to it, so a
  // reply to any part resolves to the same text.
  const row = store.db
    .prepare(
      `SELECT id, sequence, direction, body_cipher, created_at
         FROM messages
        WHERE conversation_id = ?
          AND (external_message_id = ?
               OR id IN (SELECT message_id FROM message_parts WHERE provider_message_id = ?))
        ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId, replyToExternalId, replyToExternalId);
  if (!row) return { found: false, externalMessageId: replyToExternalId };
  try {
    return {
      found: true,
      externalMessageId: replyToExternalId,
      id: row.id,
      sequence: row.sequence,
      direction: row.direction,
      createdAt: row.created_at,
      text: String(decryptBody(store.tenantId, row.body_cipher) || ''),
    };
  } catch {
    return { found: false, externalMessageId: replyToExternalId };
  }
}

export function quotedReplyPreamble(quoted, around = []) {
  if (!quoted) return '';
  if (!quoted.found) {
    return (
      "The user used WhatsApp's reply gesture, but the quoted message is not in " +
      "this conversation's record, so you cannot see what they pointed at. Do not " +
      'guess why and do not blame its age — just ask what they are referring ' +
      'to.\n\n---\n'
    );
  }
  const who = quoted.direction === 'inbound' ? 'their own earlier message' : 'the earlier reply';
  const line = transcriptLine;
  const before = around.filter((m) => m.side === 'before');
  const after = around.filter((m) => m.side === 'after');

  let out = `The user is replying directly to ${who} (sent ${quoted.createdAt}):\n`;
  out += `"""\n${quoted.text}\n"""\n`;
  if (before.length || after.length) {
    // A quote read alone loses the thread it belonged to, and the agent then
    // answers the sentence instead of the conversation.
    out += '\nWhat surrounded it at the time:\n';
    if (before.length) out += `${before.map(line).join('\n')}\n`;
    out += `>>> ${line({ direction: quoted.direction, text: quoted.text })}\n`;
    if (after.length) out += `${after.map(line).join('\n')}\n`;
  }
  out += '\nAnswer in that context.\n\n---\n';
  return out;
}


export function toolAvailabilityPreamble({ toolkits = [], connectable = [], sidecarHealthy = true } = {}) {
  if (!sidecarHealthy) {
    return (
      'Right now your external tools (email, calendar, tasks) are unavailable, so ' +
      'anything needing them will fail. Say that plainly in one line, without ' +
      'naming any internal system or blaming the user, do not claim to have done ' +
      'anything external, and answer whatever you can from the conversation ' +
      'itself.\n\n---\n'
    );
  }
  // Stating the connected set alone reads as a closed world: asked for Linear
  // while holding gmail/calendar/asana, the agent answered "not available in
  // your setup" and never called the tool that would have connected it. What is
  // connectable has to be stated too, in the same always-read place (P11).
  const offer = connectable.length
    ? `Not connected yet, but you can connect any of these for the user right now: ${connectable.join(', ')}. ` +
      'To do it, call the `connect_account` tool and send the user the link it ' +
      'returns — do not ask them to run a command and do not say a toolkit is ' +
      'unavailable, unsupported or "not in your setup" when it is on this list. ' +
      'Only the tool result tells you whether it worked; never claim you checked ' +
      'a connection unless you actually called a tool. '
    : '';
  if (toolkits.length > 0) {
    // Saying nothing here was a mistake. The transcript can contain many older
    // turns where a toolkit genuinely was unavailable, and with no present-tense
    // statement of capability the agent keeps repeating them — observed live,
    // refusing a calendar request while holding six working calendar tools.
    return (
      `Connected and working right now: ${toolkits.join(', ')}. ` +
      'Use them. Do not speculate about whether a connection worked, do not ask ' +
      'the user to reconnect, and ignore anything earlier in this conversation ' +
      'that says these are unavailable — that is stale. If a tool call actually ' +
      `fails, report what failed. ${offer}`.trimEnd() + '\n\n---\n'
    );
  }
  return (
    'You have no external accounts connected for this user yet — no email, ' +
    'calendar, drive or task tools. If they ask for something that needs one, do ' +
    'not attempt it and do not imply it succeeded. Tell them which account needs ' +
    `connecting and connect it for them. ${offer}`.trimEnd() + '\n\n---\n'
  );
}
