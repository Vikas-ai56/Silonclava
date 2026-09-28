/**
 * Shared authenticated-encryption primitive.
 *
 * Extracted from the tenant control plane's vault crypto module so the
 * Phase 3C transcript store can encrypt at rest without production code
 * reaching into the credential control plane's private directories — a
 * boundary enforced by `test/tenant-control-plane-boundary.test.mjs`.
 *
 * The derivation context, envelope shape, and version are byte-for-byte
 * unchanged, so records written by the previous implementation still decrypt.
 * There is exactly one AEAD implementation; the vault facade re-exports this.
 */
import crypto from 'node:crypto';

const ENVELOPE_VERSION = 2;
const LEGACY_ENVELOPE_VERSION = 1;
const DISCRIMINATOR = '_rockyVault';
const LEGACY_DISCRIMINATOR = '_riftVault';
const CONTEXT_PREFIX = 'rocky-vault';
const LEGACY_CONTEXT_PREFIX = 'rift-vault';
const ALGORITHM = 'aes-256-gcm';
const KDF = 'hkdf-sha256';

function decodeMasterKey(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('ROCKY_VAULT_MASTER_KEY is required');
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const key = Buffer.from(padded, 'base64');
  if (key.length !== 32) {
    throw new Error('ROCKY_VAULT_MASTER_KEY must decode to exactly 32 bytes');
  }
  return key;
}

export function validateMasterKey(raw = process.env.ROCKY_VAULT_MASTER_KEY) {
  try {
    decodeMasterKey(raw);
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}

export function assertMasterKey(raw = process.env.ROCKY_VAULT_MASTER_KEY) {
  decodeMasterKey(raw);
}

function masterKey() {
  return decodeMasterKey(process.env.ROCKY_VAULT_MASTER_KEY);
}

function recordContext(tenantId, recordName, version = ENVELOPE_VERSION) {
  const tenant = String(tenantId || '');
  const record = String(recordName || '');
  if (!/^[A-Za-z0-9_-]+$/.test(tenant)) throw new Error('Invalid tenant id for vault record');
  if (!/^[A-Za-z0-9_-]+$/.test(record)) throw new Error('Invalid vault record name');
  const prefix = version === LEGACY_ENVELOPE_VERSION ? LEGACY_CONTEXT_PREFIX : CONTEXT_PREFIX;
  return `${prefix}:v${version}:${tenant}:${record}`;
}

export function envelopeVersion(value) {
  if (!value || typeof value !== 'object') return null;
  if (value[DISCRIMINATOR] === ENVELOPE_VERSION) return ENVELOPE_VERSION;
  if (value[LEGACY_DISCRIMINATOR] === LEGACY_ENVELOPE_VERSION) return LEGACY_ENVELOPE_VERSION;
  return null;
}

export function isLegacyEnvelope(value) {
  return envelopeVersion(value) === LEGACY_ENVELOPE_VERSION;
}

function deriveRecordKey(root, salt, context) {
  return Buffer.from(crypto.hkdfSync('sha256', root, salt, Buffer.from(context), 32));
}

export function isEncryptedEnvelope(value) {
  return Boolean(
    envelopeVersion(value) !== null &&
    value.alg === ALGORITHM &&
    value.kdf === KDF &&
    typeof value.ciphertext === 'string',
  );
}

export function encryptValue(tenantId, recordName, value) {
  const root = masterKey();
  const context = recordContext(tenantId, recordName);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveRecordKey(root, salt, context);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context));
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyId = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return {
    [DISCRIMINATOR]: ENVELOPE_VERSION,
    alg: ALGORITHM,
    kdf: KDF,
    keyId,
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function decryptValue(tenantId, recordName, envelope) {
  if (!isEncryptedEnvelope(envelope)) throw new Error('Unsupported vault envelope');
  const root = masterKey();
  const expectedKeyId = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  if (envelope.keyId !== expectedKeyId) {
    throw new Error(`Vault key mismatch for ${recordName}`);
  }
  const context = recordContext(tenantId, recordName, envelopeVersion(envelope));
  const salt = Buffer.from(envelope.salt, 'base64url');
  const iv = Buffer.from(envelope.iv, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  const key = deriveRecordKey(root, salt, context);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error(`Vault authentication failed for ${recordName}`);
  }
}
