function trueFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

/** Forwarding is message provenance, not a separate audio transport. */
export function forwardingMetadata(params = {}) {
  const frequentlyForwarded = trueFlag(params.FrequentlyForwarded);
  return {
    forwarded: trueFlag(params.Forwarded) || frequentlyForwarded,
    frequentlyForwarded,
  };
}
