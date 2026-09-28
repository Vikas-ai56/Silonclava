import { handleInbound, resolveInboundSender } from './onboarding.mjs';
import {
  enqueueForTenant,
  configureScheduler,
  recoverTenantLane,
} from './inbound-queue.mjs';
import { turnInboundRows, turnAttachments } from './tenant-data/queue-store.mjs';
import { toWhatsAppText } from './whatsapp-format.mjs';
import { chunkForWhatsApp } from './whatsapp-chunk.mjs';
import { snapshotWorkspace, createdSince, deliverOutbox, deliverWorkspaceFile } from './outbox.mjs';
import { extractMediaMarkers } from './media-markers.mjs';
import { recordOutboundMedia } from './tenant-data/delivery-store.mjs';
import { configureAdmission } from './openclaw/tenant-gateway.mjs';
import { isCronWarm, requeueEvictedCronWake } from './wake-scheduler.mjs';
import { typicalGapMs } from './tenant-data/rhythm.mjs';
import { transcriptBodyFor, attachmentPreamble } from './inbound-media.mjs';
import { createTenantClient } from './tenant-cli/client.mjs';
import {
  quotedMessage,
  quotedReplyPreamble,
  toolAvailabilityPreamble,
} from './tenant-data/turn-context.mjs';
import {
  saveResponse,
  beginSend,
  recordSendResult,
  recordMessageParts,
  markDeliveryUnknown,
  turnsAwaitingSend,
  committedResponseText,
} from './tenant-data/delivery-store.mjs';
import { createDeferredChannel } from './channel.mjs';
import {
  contextNeeded,
  assembleContext,
  interruptedTurnPreamble,
  messagesAround,
} from './tenant-data/context-store.mjs';
import { tenantDbPath } from './tenant-data/open.mjs';
import { TURN_STATE } from './tenant-data/migrations.mjs';
import { decryptBody, openTenantStore } from './tenant-data/store.mjs';
import fs from 'node:fs';
import { loadTenant, listTenants } from './tenants.mjs';

/**
 * Channel inbound → resolve tenant → durable per-tenant lane → onboarding/router.
 *
 * Resolution happens before the enqueue (SPEC-phase3c §5): a non-allow-listed
 * sender is dropped before any tenant data or transcript row exists, and an
 * allow-listed sender is keyed by resolved `tenant.id` rather than by the phone
 * digits, which used to let one tenant's aliases open separate lanes.
 */

/** Rebuild the turn's request from the ledger. A coalesced turn replays every
 *  source message in order, which is what makes total re-execution faithful. */
/**
 * The address the tenant's current turn is bound to, taken from the turn
 * envelope (§5) rather than anything the model produced. Delivery tools read
 * it from here so a model cannot name its own recipient.
 */
const turnRecipients = new Map();

export function lastRecipientFor(tenantId) {
  return turnRecipients.get(tenantId) || null;
}

const TYPING_REFRESH_MS = 20_000;
const TYPING_MAX_REFRESHES = 9;

/**
 * Best effort and self-limiting: a cosmetic indicator must never fail a turn,
 * hold it open, or keep firing at a provider after the turn has gone wrong.
 */
function startTypingHeartbeat(channel, to, messageId) {
  if (!messageId || typeof channel?.setTyping !== 'function') {
    console.warn(
      `[typing] skipped: messageId=${messageId ?? 'null'} setTyping=${typeof channel?.setTyping}`,
    );
    return { stop() {} };
  }
  let stopped = false;
  let sent = 0;
  const fire = () => {
    if (stopped) return;
    Promise.resolve(channel.setTyping(to, true, { messageId }))
      .then((r) => {
        // Swallowing the result entirely was a mistake: when the bubble did not
        // appear there was nothing in the log to say why.
        if (r && r.ok === false && !r.skipped) {
          console.warn(`[typing] ${messageId}: ${JSON.stringify(r).slice(0, 160)}`);
        }
      })
      .catch((err) => console.warn(`[typing] ${messageId}: ${String(err?.message || err).slice(0, 120)}`));
  };
  fire();
  const timer = setInterval(() => {
    if (stopped || (sent += 1) >= TYPING_MAX_REFRESHES) return clearInterval(timer);
    fire();
  }, TYPING_REFRESH_MS);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

const TOOL_STATE_TTL_MS = 60_000;
const toolStateCache = new Map();

/**
 * Drop the cached tool state for a tenant. Called the moment a connection
 * completes: otherwise the agent keeps telling the user a toolkit is not
 * connected for up to a minute after they finished authorising it — it did
 * exactly that with Asana, one message after announcing the connection.
 */
export function invalidateToolState(tenantId) {
  toolStateCache.delete(tenantId);
}

/**
 * What the agent may claim it can do. "Approved" is what the org permits for
 * this tenant; only "connected" means an account is actually linked, and the
 * agent must not offer Gmail on the strength of an org policy alone.
 *
 * Cached briefly: this runs on every turn and a loopback round trip per turn
 * is pure latency on the user's reply.
 */
/**
 * Pull every attachment into the tenant's own workspace and describe it.
 * A fetch that fails is recorded as a failed attachment rather than dropped:
 * the user did send something, and the agent should say so rather than answer
 * as if the message were empty.
 */
async function speakReply(store, tenantId, turnId, reply, messageIds) {
  if (!reply) return;
  try {
    const {
      voiceReplyConfigured, turnHadVoiceNote, synthesizeReplyToOutbox, replyIsSpeakable,
    } = await import('./speech/voice-reply.mjs');
    if (!voiceReplyConfigured()) return;

    const { turnAttachments } = await import('./tenant-data/queue-store.mjs');
    if (!turnHadVoiceNote(turnAttachments(store, messageIds))) return;

    if (!replyIsSpeakable(reply)) {
      console.log(`[voice] ${tenantId}: reply too long to speak — sending text only`);
      return;
    }

    const path = await import('node:path');
    const { TENANTS_DIR } = await import('./paths.mjs');
    const outboxDir = path.join(TENANTS_DIR, tenantId, 'workspace', 'outbox');
    const made = await synthesizeReplyToOutbox({ tenantId, text: reply, outboxDir, turnId });
    if (made) console.log(`[voice] ${tenantId}: spoke reply as ${made.file} (${made.bytes}b)`);
  } catch (err) {
    console.warn(`[voice] ${tenantId}: could not speak the reply — ${String(err?.message || err).slice(0, 140)}`);
  }
}

async function isProviderRetry(tenantId, msg, channelAccount) {
  const externalMessageId = msg.externalMessageId || msg.id || null;
  if (!externalMessageId) return false;
  const { openTenantStore } = await import('./tenant-data/store.mjs');
  const { alreadyAccepted } = await import('./tenant-data/queue-store.mjs');
  const store = openTenantStore(tenantId);
  try {
    return alreadyAccepted(store, {
      channel: msg.channel || 'whatsapp',
      channelAccount: String(channelAccount),
      externalMessageId,
    });
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}

async function collectAttachments(tenantId, msg) {
  const items = Array.isArray(msg.media) ? msg.media : [];
  if (items.length === 0) return [];

  const { fetchInboundMedia } = await import('./inbound-media.mjs');
  const { getAdapter } = await import('./channels/index.mjs');
  const adapter = getAdapter(msg.channelProvider || 'twilio');
  const auth = typeof adapter?.mediaAuth === 'function' ? await adapter.mediaAuth() : null;

  const out = [];
  for (const [index, item] of items.entries()) {
    try {
      const saved = await fetchInboundMedia(tenantId, { ...item, index, auth });
      if (saved.kind === 'audio') saved.transcript = await transcribeIfPossible(tenantId, saved);
      out.push(saved);
      console.log(`[media] ${tenantId}: saved ${saved.kind} ${saved.file} (${saved.bytes}b)`);
    } catch (err) {
      console.warn(`[media] ${tenantId}: attachment ${index} failed:`, err?.message || err);
      out.push({ kind: 'document', file: `attachment-${index}`, contentType: item.contentType || 'unknown', bytes: 0, failed: true });
    }
  }
  return out;
}

/**
 * Transcription runs inside the tenant container, through the `rocky-transcribe`
 * binary baked into the image (ffmpeg + whisper.cpp), so a client's voice never
 * leaves the tenant boundary and no external service is involved. Claude has no
 * audio input modality, so without this a voice note is silence.
 */
async function transcribeIfPossible(tenantId, saved) {
  try {
    const { transcribeAudio } = await import('./transcription.mjs');
    return await transcribeAudio(tenantId, saved);
  } catch (err) {
    const detail = String(err?.message || err);
    console.warn(`[media] ${tenantId}: transcription unavailable:`, detail.slice(0, 120));
    saved.transcriptFailure = /30 seconds|duration exceeds|too long|maxInputBytes|above the/i.test(detail)
      ? 'too-long'
      : 'unavailable';
    return null;
  }
}

async function toolAvailability(tenant) {
  const cached = toolStateCache.get(tenant.id);
  if (cached && Date.now() - cached.at < TOOL_STATE_TTL_MS) return cached.value;

  let value;
  try {
    // Public facade only — the credential control plane is off limits to
    // production callers (tenant-control-plane-boundary.test.mjs).
    // The command envelope is {ok, resource, action, result}. Reading
    // `.connections` off the envelope instead of off `.result` silently
    // yielded zero toolkits, so the agent was told it had nothing connected
    // while holding six working calendar tools.
    const client = createTenantClient({ tenantId: tenant.id });
    const envelope = await client.mcp().list();
    const rows = envelope?.result?.connections || [];
    if (!Array.isArray(rows)) throw new Error('mcp list returned no connections array');
    const toolkits = rows
      .filter((c) => !c.status || String(c.status).toLowerCase() === 'active')
      .map((c) => c.toolkit || c.slug)
      .filter(Boolean);
    // What the agent MAY connect, not just what it already has. Without this the
    // connected list reads as a closed world and the agent tells the user a
    // toolkit is unsupported rather than connecting it. The org bundle is local,
    // so a failure here must not mark the connector unhealthy.
    let connectable = [];
    try {
      const avail = await client.mcp().available();
      connectable = (avail?.result?.toolkits || [])
        .map((entry) => entry?.slug || entry)
        .filter((slug) => slug && !toolkits.includes(slug));
    } catch (err) {
      console.warn(`[tools] ${tenant.id}: could not read the org bundle (${String(err?.message || err).slice(0, 80)})`);
    }
    value = { toolkits, connectable, sidecarHealthy: true };
  } catch (err) {
    // Unreachable connector and "nothing connected" are different states and
    // the agent says different things about them.
    console.warn(`[tools] ${tenant.id}: connector unavailable (${String(err?.message || err).slice(0, 90)})`);
    value = { toolkits: [], connectable: [], sidecarHealthy: false };
  }

  toolStateCache.set(tenant.id, { at: Date.now(), value });
  return value;
}

function requestForTurn(store, tenantId, turnId) {
  const rows = turnInboundRows(store, turnId);
  const texts = rows
    .map((row) => decryptBody(tenantId, row.body_cipher))
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  // Several messages in one turn are separate things the user said, not one
  // paragraph. Numbering them is the whole fix for "it only answered one" —
  // no timers, no windows, just say what arrived.
  const text = texts.length > 1
    ? `The user sent ${texts.length} messages before you replied. Answer all of them.\n\n` +
      texts.map((t, i) => `[${i + 1}] ${t}`).join('\n')
    : texts.join('\n');

  return {
    text,
    count: rows.length,
    messageIds: rows.map((r) => r.id),
    // The recipient stored with the accepted message, never a mutable module
    // variable or a model-supplied address (§5).
    channelAccount: rows[0]?.channel_account || null,
    latestExternalMessageId: rows[rows.length - 1]?.external_message_id || null,
    channel: rows[0]?.channel || 'whatsapp',
    // The newest message in a coalesced turn is the one the user replied to.
    replyToExternalId: rows[rows.length - 1]?.reply_to_external_id || null,
  };
}

/**
 * Persist-before-send (§6, §7): commit the approved bytes, then send exactly
 * those bytes to the recipient stored on the turn.
 *
 * A commit failure sends nothing. A send that starts without producing a
 * definitive receipt is `delivery_unknown` — never blindly resent, because the
 * provider may already have delivered it.
 */
export async function deliverResponse(channel, store, turnId, text, options = {}) {
  const saved = saveResponse(store, turnId, text, options);
  const attempt = beginSend(store, turnId, saved.messageId);
  // Another writer started this send first. The bytes are committed, so the
  // turn is not lost — whoever holds the send owns finishing it.
  if (attempt === null) {
    // Two actors reached the same committed turn. Rare and benign, but silence
    // here would hide a resend racing a live send on every delivery.
    console.warn(
      `[delivery] ${store.tenantId}: turn ${turnId} was already claimed for sending — skipping this send`,
    );
    return { ...saved, attempt: null, skipped: 'send-already-started' };
  }
  try {
    // Cut the reply ourselves. Handing the provider a body over the limit makes
    // it deliver several messages whose ids we never see, and a reply to one of
    // those cannot be resolved back to what was said.
    const parts = chunkForWhatsApp(text);
    const ids = [];
    let receipt = null;
    for (const part of parts) {
      receipt = await channel.sendText(saved.recipient, part, { tenantId: store.tenantId });
      if (receipt?.providerMessageId) ids.push(receipt.providerMessageId);
      if (receipt?.ok === false) break;
    }
    recordMessageParts(store, saved.messageId, ids);
    if (parts.length > 1) {
      // Worth seeing: it is the difference between one provider message and
      // several, and a reply to any part has to resolve back to this turn.
      console.log(
        `[delivery] ${store.tenantId}: reply sent as ${parts.length} parts, ${ids.length} id(s) recorded`,
      );
    }
    recordSendResult(store, turnId, saved.messageId, attempt, {
      ok: receipt?.ok !== false,
      providerMessageId: ids[0] ?? receipt?.providerMessageId ?? null,
      status: receipt?.status,
      errorCode: receipt?.errorCode,
      acceptedAt: receipt?.acceptedAt,
    });
    return { ...saved, attempt, receipt, parts: ids.length };
  } catch (err) {
    // The request may have reached the provider before it failed, so this is
    // ambiguous rather than failed.
    markDeliveryUnknown(store, turnId, saved.messageId, attempt, err?.code || 'SEND_ERROR');
    throw err;
  }
}

/**
 * Turns committed but never confirmed sent — re-send the saved bytes without
 * re-invoking the model (§6). Run at boot, after recovery.
 */
export async function resendCommittedResponses(channel, store) {
  let sent = 0;
  for (const turn of turnsAwaitingSend(store)) {
    const text = committedResponseText(store, turn.id);
    if (!text) continue;
    const attempt = beginSend(store, turn.id, turn.response_message_id);
    // The live path claimed it between the scan and now; it owns the send.
    if (attempt === null) {
      console.log(`[queue] ${store.tenantId}: turn ${turn.id} claimed by the live path — resend skipped`);
      continue;
    }
    try {
      const receipt = await channel.sendText(turn.recipient, text, { tenantId: store.tenantId });
      recordSendResult(store, turn.id, turn.response_message_id, attempt, {
        ok: receipt?.ok !== false,
        providerMessageId: receipt?.providerMessageId ?? null,
        status: receipt?.status,
        errorCode: receipt?.errorCode,
        acceptedAt: receipt?.acceptedAt,
      });
      sent += 1;
    } catch (err) {
      markDeliveryUnknown(store, turn.id, turn.response_message_id, attempt, err?.code || 'SEND_ERROR');
    }
  }
  return sent;
}

export function attachRouter(channel) {
  configureAdmission({
    cronWarm: (tenantId) => isCronWarm(tenantId),
    cronEvicted: (tenantId) => requeueEvictedCronWake(tenantId),
    rhythm: (tenantId) => {
      try {
        const store = openTenantStore(tenantId, { readonly: true });
        try {
          return typicalGapMs(store, tenantId);
        } finally {
          store.db?.close?.();
        }
      } catch {
        return undefined;
      }
    },
  });

  configureScheduler({
    runTurn: async ({ tenantId, turn, store }) => {
      const tenant = await loadTenant(tenantId);
      if (!tenant) throw new Error(`Turn claimed for unknown tenant ${tenantId}`);

      const { text, count, channelAccount, channel: ch, messageIds, replyToExternalId,
        latestExternalMessageId } = requestForTurn(store, tenantId, turn.id);
      if (count > 1) {
        console.log(`[queue] ${tenantId} coalesced ${count} messages → one turn`);
      }

      // The agent's memory is our transcript, not OpenClaw's session (§7).
      // When the container generation has changed the session may be gone, so
      // replay a bounded window of the durable record rather than starting
      // blank. Costs nothing on a warm session: contextNeeded returns false.
      let prompt = text;
      if (turn.attempt > 1) prompt = `${interruptedTurnPreamble()}${prompt}`;

      // Only facts about THIS turn. The standing rules live in the managed
      // guardrail block of the tenant's AGENTS.md, which OpenClaw injects into
      // the system prompt — repeating them here cost ~1.2KB on every message
      // and put them in the weaker position.
      const preambles = [];
      preambles.push(attachmentPreamble(turnAttachments(store, messageIds)));
      preambles.push(toolAvailabilityPreamble(await toolAvailability(tenant)));
      const quoted = quotedMessage(store, turn.conversation_id, replyToExternalId);
      if (quoted) {
        // A quote alone is a sentence without its thread, so replay what
        // surrounded it.
        const around = quoted.found
          ? messagesAround(store, turn.conversation_id, quoted.sequence, {
              fromSequence: tenant.sessionFromSequence || 0,
            })
          : [];
        preambles.push(quotedReplyPreamble(quoted, around));
        console.log(
          `[reply-ctx] ${tenantId}: replying to ${replyToExternalId}` +
            `${quoted.found ? ` (+${around.length} surrounding)` : ' (not in the record)'}`,
        );
      }
      const preamble = preambles.filter(Boolean).join('');
      if (preamble) prompt = `${preamble}${prompt}`;
      console.log(
        `[prompt] ${tenantId}: preamble=${preamble.length}b tools=${/Connected and working/.test(preamble) ? 'stated' : 'none'}`,
      );
      const need = contextNeeded(store, turn.conversation_id, turn.runtime_generation ?? undefined);
      if (need.needed) {
        const ctx = assembleContext(store, turn.conversation_id, {
          excludeIds: messageIds,
          fromSequence: tenant.sessionFromSequence || 0,
        });
        if (ctx) {
          prompt = `${preamble}${ctx.text}${text}`;
          console.log(
            `[context] ${tenantId}: replayed ${ctx.messages} message(s)` +
              `${ctx.usedCheckpoint ? ' + checkpoint' : ''} (${need.reason})`,
          );
        }
      }

      // Typing bubble for the duration of the turn. Twilio also marks the
      // referenced message read, which is what turns the sender's ticks blue.
      // It expires after 25s, and a cold container start already costs ~24s,
      // so it is refreshed until the turn produces a reply.
      if (channelAccount) turnRecipients.set(tenantId, channelAccount);

      // Files the turn produces are delivered by convention, not by the model
      // electing to call a tool. The snapshot is the instrumentation half: it
      // measures how often a turn writes a file the user never receives.
      const filesBefore = snapshotWorkspace(tenantId);

      const typing = startTypingHeartbeat(channel, channelAccount, latestExternalMessageId);

      // Nothing reaches the user during the turn: the deferred channel
      // captures what the turn wants to say so it can be committed first (§7).
      const deferred = createDeferredChannel(channel);
      try {
        await handleInbound(
          deferred,
          {
          from: channelAccount,
          chatJid: channelAccount,
          channel: ch,
          text: prompt,
          // The raw user text, kept separate from the model prompt. Command
          // intents are anchored with ^, and `prompt` is prefixed with
          // preambles and replayed context — so matching against it silently
          // broke "connect gmail" for every tenant whose session needed a
          // replay, and the model improvised an authorisation flow instead.
          commandText: text,
        },
          {
            ok: true,
            tenant,
            jid: channelAccount || tenant.jid,
            phone: tenant.phone,
            isNewOperator: false,
            isNewTenant: false,
          },
        );
      } finally {
        // A failed turn must not leave the user watching a typing bubble.
        typing.stop();
      }

      // Normalise to WhatsApp's own markup BEFORE committing, so the bytes in
      // the ledger are exactly the bytes sent (§6). Models reach for Markdown;
      // WhatsApp renders **bold** as literal asterisks.
      // OpenClaw's own attachment convention reaches us as literal text because
      // we capture the model's output instead of its channel. Turn it into a
      // delivery rather than printing it.
      const { text: spoken, paths: markerPaths } = extractMediaMarkers(deferred.text());
      const reply = toWhatsAppText(spoken);

      // Delivery runs after the text, in both branches: a turn may answer with
      // a file and no words. A send failure here cannot cost the user the reply.
      const settleFiles = async () => {
        for (const rel of markerPaths) {
          await deliverWorkspaceFile(channel, tenantId, channelAccount, rel)
            .then((d) => console.log(`[media] ${tenantId}: sent ${d.file} (marker)`))
            .catch((err) => console.warn(`[media] ${tenantId}: ${rel} — ${err?.message || err}`));
        }
        const out = await deliverOutbox(channel, tenantId, channelAccount).catch((err) => {
          console.warn(`[outbox] ${tenantId}: delivery failed — ${err?.message || err}`);
          return { delivered: [], failed: [], skipped: 0 };
        });
        // A refusal the user never hears about is the same silent failure in
        // another coat.
        for (const r of out.refused || []) {
          await channel
            .sendText(
              channelAccount,
              `I could not send *${r.file}* — WhatsApp does not accept that file type. ` +
                'Ask me for it as a PDF and I will send it.',
              { tenantId },
            )
            .catch((err) => console.warn(`[outbox] ${tenantId}: refusal notice failed — ${err?.message || err}`));
        }
        // A file the agent sent is a message the user can reply to, so it has
        // to exist in the record with the provider's id.
        for (const d of out.delivered || []) {
          try {
            recordOutboundMedia(store, {
              conversationId: turn.conversation_id,
              channel: ch,
              recipient: channelAccount,
              file: d.file,
              externalMessageId: d.providerMessageId,
            });
          } catch (err) {
            console.warn(`[outbox] ${tenantId}: could not record ${d.file} — ${err?.message || err}`);
          }
        }
        const stranded = createdSince(filesBefore, snapshotWorkspace(tenantId));
        if (stranded.length || out.delivered.length) {
          console.log(
            `[outbox] ${tenantId}: delivered=${out.delivered.length} ` +
              `stranded=${stranded.length}${stranded.length ? ` (${stranded.map((f) => f.split('/').pop()).join(', ')})` : ''}`,
          );
        }
        return out;
      };

      if (!reply) {
        await settleFiles();
        return { state: TURN_STATE.COMPLETED };
      }

      // Commit, then send the committed bytes. The scheduler must not also mark
      // this turn: delivery owns its terminal state from here.
      await deliverResponse(channel, store, turn.id, reply, {
        generation: turn.runtime_generation ?? undefined,
        channel: ch,
      });
      await speakReply(store, tenantId, turn.id, reply, messageIds);
      await settleFiles();
      return null;
    },
  });

  channel.onMessage = async (msg) => {
    const resolved = await resolveInboundSender(msg);
    if (!resolved.ok) return;

    const { tenant, jid } = resolved;
    const replyTo = msg.chatJid || msg.from || jid;


    // A brand-new sender gets its onboarding reply inline: there is no
    // conversation history to order it against, and it must not consume a
    // model turn slot.
    if (resolved.isNewTenant) {
      await handleInbound(channel, msg, resolved);
      return;
    }

    // Media is fetched here, before the message is persisted, so the ledger
    // records what the user actually sent rather than a URL that expires.
    if (await isProviderRetry(tenant.id, msg, replyTo)) {
      console.log(`[queue] ${tenant.id}: provider retry of ${msg.externalMessageId} — already accepted`);
      return;
    }
    const attachments = await collectAttachments(tenant.id, msg);
    const body = attachments.length
      ? transcriptBodyFor({ caption: msg.text, attachments })
      : String(msg.text || '');

    const result = enqueueForTenant(tenant.id, {
      conversationId: tenant.id,
      channel: msg.channel || 'whatsapp',
      channelAccount: String(replyTo),
      externalMessageId: msg.externalMessageId || msg.id || null,
      replyToExternalId: msg.replyToExternalId || null,
      body,
      attachments,
    });

    // No busy ack. It promised to finish the earlier message and take this one
    // next — but a coalesced message joins the turn that is already pending, so
    // there is no "next": both are answered together. The ack described a queue
    // that does not exist, and cost the user an extra message every time.
    if (result.coalescedInto) {
      console.log(`[queue] ${tenant.id}: message joined the pending turn`);
    }
  };
  return channel;
}

/**
 * Restart recovery (§5). Returns turns left `running` by a crash to `queued`
 * for every known tenant, so nothing is silently lost across a restart.
 */
export async function resendAllCommittedResponses(channel) {
  let resent = 0;
  for (const tenant of await listTenants()) {
    if (!fs.existsSync(tenantDbPath(tenant.id))) continue;
    let store = null;
    try {
      store = openTenantStore(tenant.id);
      resent += await resendCommittedResponses(channel, store);
    } catch (err) {
      console.warn(`[queue] resend skipped for ${tenant.id}:`, err?.message || err);
    } finally {
      store?.db?.close?.();
    }
  }
  if (resent) console.log(`[queue] re-sent ${resent} committed but undelivered response(s)`);
  return resent;
}

export async function recoverAllTenantLanes({ writesEnabled = false } = {}) {
  const writeToolsActive = writesEnabled;
  let recovered = 0;
  for (const tenant of await listTenants()) {
    // Only tenants that have actually persisted something. Opening a store
    // would create the database, so recovery must not be what brings every
    // tenant's ledger into existence on boot.
    if (!fs.existsSync(tenantDbPath(tenant.id))) continue;
    try {
      recovered += recoverTenantLane(tenant.id, { writesEnabled: writeToolsActive });
    } catch (err) {
      console.warn(`[queue] recovery skipped for ${tenant.id}:`, err?.message || err);
    }
  }
  if (recovered) console.log(`[queue] recovered ${recovered} interrupted turn(s)`);
  return recovered;
}
