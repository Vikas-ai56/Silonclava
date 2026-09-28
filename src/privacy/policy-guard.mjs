/**
 * Persistence policy guard (SPEC-phase3c §7).
 *
 * A local host module between inbound/model output and the database. It is not
 * an MCP server and not a second credential control plane.
 *
 * Ordinary personal information is *allowed* — it is encrypted and retained.
 * This guard blocks only the classes §7 says must never become transcript:
 * authorization codes, passwords, API keys, tokens, cookies, private keys, and
 * payment-card secrets. Those route through the dedicated auth flow or a
 * provider-hosted payment page instead.
 *
 * Findings never carry the matched text. A guard that echoed the secret into an
 * error message would defeat its own purpose, since errors reach logs.
 */

export class PersistencePolicyError extends Error {
  constructor(classes) {
    super(`Blocked by persistence policy: ${classes.join(', ')}`);
    this.name = 'PersistencePolicyError';
    this.code = 'PERSISTENCE_POLICY_BLOCKED';
    this.classes = classes;
  }
}

const RULES = [
  { id: 'private_key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  // Vendor-prefixed credentials. Prefixes are distinctive enough that a false
  // positive on ordinary prose is unlikely.
  { id: 'api_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'api_key', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/ },
  { id: 'api_key', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { id: 'api_key', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'api_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // JWTs and bearer tokens.
  { id: 'token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'token', re: /\b(?:bearer|access_token|refresh_token|id_token)\b["'\s:=]+[A-Za-z0-9._-]{20,}/i },
  // OAuth authorization codes as they appear in a pasted callback URL.
  { id: 'oauth_code', re: /[?&]code=[A-Za-z0-9._%~-]{16,}/ },
  { id: 'cookie', re: /\b(?:set-cookie|session(?:id)?|sid)\s*[:=]\s*[A-Za-z0-9._-]{24,}/i },
  // Labelled secrets. Requires the label, so "my pin is on the desk" is safe
  // but "pin: 4821" is not.
  { id: 'password', re: /\b(?:password|passwd|passphrase)\s*[:=]\s*\S{4,}/i },
  { id: 'otp', re: /\b(?:otp|one[- ]time (?:code|password)|verification code)\s*[:=]?\s*\b\d{4,8}\b/i },
  { id: 'card_pin', re: /\b(?:pin|cvv|cvc|cvv2|csc)\s*[:=]\s*\d{3,6}\b/i },
];

/** Luhn check, so a 16-digit deal size or account reference is not mistaken
 *  for a payment card. */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Issuer prefixes, so an arbitrary long figure is not treated as a card.
const CARD_IIN = /^(?:4\d{12,18}|5[1-5]\d{14}|2(?:2[2-9]|[3-6]\d|7[01])\d{12}|27\d{14}|3[47]\d{13}|6(?:011|5\d{2}|4[4-9]\d)\d{12}|35(?:2[89]|[3-8]\d)\d{12})$/;
const CARD_CONTEXT = /\b(?:card|credit|debit|visa|mastercard|amex|maestro|rupay|cvv|cvc|expiry|exp\s*date)\b/i;

/**
 * Luhn alone is far too loose here: roughly one in ten 16-digit figures passes
 * it, and this is an investment bank where large numbers appear in ordinary
 * prose. A false positive does not redact — it blocks the message outright
 * (§7), so the rule additionally requires a real issuer prefix plus either
 * card-style grouping or nearby card vocabulary.
 */
function hasPaymentCard(text) {
  const hasContext = CARD_CONTEXT.test(text);
  const candidates = text.match(/\b(?:\d[ -]?){12,18}\d\b/g) || [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    if (!CARD_IIN.test(digits)) continue;
    const grouped = /\d[ -]\d/.test(candidate);
    if (grouped || hasContext) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {string[]} sorted, de-duplicated policy classes; empty when clean.
 */
export function classifyForPersistence(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const found = new Set();
  for (const rule of RULES) {
    if (rule.re.test(value)) found.add(rule.id);
  }
  if (hasPaymentCard(value)) found.add('payment_card');
  return [...found].sort();
}

/**
 * Throws rather than redacting. §7 requires a policy failure to *block sending*,
 * not to fall back to an unrecorded or silently altered response.
 */
export function assertPersistable(text) {
  const classes = classifyForPersistence(text);
  if (classes.length) throw new PersistencePolicyError(classes);
  return true;
}
