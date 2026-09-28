import crypto from 'node:crypto';

/**
 * Normalize a WhatsApp number into a digits-only id and Baileys-style JID.
 * Accepts +92..., 92..., or bare local digits (caller should pass country code).
 */
export function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Enter a valid WhatsApp number with country code');
  }
  return {
    phone: digits,
    jid: `${digits}@s.whatsapp.net`,
  };
}

/** Legacy phone-key helper. Use only when discovering pre-UID tenant folders. */
export function tenantIdFromPhone(phone) {
  return String(phone).replace(/\D/g, '');
}

/** Stable opaque tenant id. Phone, JID, and email remain mutable index fields. */
export function generateTenantId() {
  return `br_${crypto.randomBytes(6).toString('hex')}`;
}
