/**
 * Keep WhatsApp “typing…” alive for any user while a slow turn (OpenClaw) runs.
 * Presence usually drops after ~15–25s unless refreshed.
 */
export async function withTyping(channel, jid, work, { pulseMs = 12_000 } = {}) {
  if (!channel || typeof channel.setTyping !== 'function' || !jid) {
    return work();
  }

  let stopped = false;
  const pulse = async () => {
    if (stopped) return;
    try {
      await channel.setTyping(jid, true);
    } catch {
      // ignore — typing is best-effort
    }
  };

  await pulse();
  const timer = setInterval(pulse, pulseMs);

  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
    try {
      await channel.setTyping(jid, false);
    } catch {
      // ignore
    }
  }
}
