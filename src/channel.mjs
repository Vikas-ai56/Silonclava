/**
 * Channel contract — Baileys will implement the same shape later.
 * MockChannel records outbound replies for local / signup testing.
 */

export class MockChannel {
  constructor() {
    /** @type {Array<{ to: string, text: string, at: string }>} */
    this.sent = [];
    this.onMessage = null;
  }

  async start() {
    // no-op; inbound comes via HTTP or CLI
  }

  async setTyping(jid, isTyping = true) {
    console.log(`[mock typing ${isTyping ? 'on' : 'off'} → ${jid}]`);
  }

  async sendText(jid, text) {
    const entry = { to: jid, text, at: new Date().toISOString() };
    this.sent.push(entry);
    console.log(`[mock → ${jid}] ${text}`);
    // No asynchronous status callbacks exist for this channel, so the send is
    // its own definitive receipt (§6).
    return {
      ...entry,
      ok: true,
      providerMessageId: `mock-${this.sent.length}`,
      status: 'delivered',
      acceptedAt: entry.at,
    };
  }

  /** Inject a simulated inbound WhatsApp message */
  async receive({ from, text }) {
    if (!this.onMessage) throw new Error('Router not attached to channel');
    return this.onMessage({ from, text, at: new Date().toISOString() });
  }

  lastSentTo(jid) {
    return [...this.sent].reverse().find((m) => m.to === jid) || null;
  }
}


/**
 * Wraps a channel so nothing is sent during a turn — outbound text is captured
 * instead (SPEC-phase3c §7: the approved bytes are committed *before* they are
 * sent).
 *
 * This is a decorator rather than a rewrite of the onboarding flow: every
 * existing `channel.sendText` call inside a turn keeps working, but its output
 * is collected and handed to the delivery ledger, which persists it and only
 * then sends the committed bytes through the real channel.
 */
export function createDeferredChannel(inner) {
  const captured = [];
  return {
    captured,
    get onMessage() { return inner.onMessage; },
    set onMessage(fn) { inner.onMessage = fn; },
    async start() { return inner.start?.(); },
    async setTyping(jid, on) { return inner.setTyping?.(jid, on); },
    async sendText(to, text) {
      const entry = { to, text: String(text ?? ''), at: new Date().toISOString() };
      captured.push(entry);
      return entry;
    },
    lastSentTo(jid) {
      return [...captured].reverse().find((m) => m.to === jid) || null;
    },
    /** Everything the turn wanted to say, as the single committed response. */
    text() {
      return captured.map((c) => c.text).filter(Boolean).join('\n\n');
    },
  };
}
