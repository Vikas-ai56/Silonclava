import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptValue,
  decryptValue,
  isEncryptedEnvelope,
  envelopeVersion,
  isLegacyEnvelope,
} from '../src/privacy/aead.mjs';

function masterKey() {
  return Buffer.from(String(process.env.ROCKY_VAULT_MASTER_KEY || '').trim(), 'base64');
}

function writeLegacyEnvelope(tenantId, recordName, value) {
  const root = masterKey();
  const context = `rift-vault:v1:${tenantId}:${recordName}`;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(crypto.hkdfSync('sha256', root, salt, Buffer.from(context), 32));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
  ]);
  return {
    _riftVault: 1,
    alg: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    keyId: crypto.createHash('sha256').update(root).digest('hex').slice(0, 16),
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

test('the v2 envelope reads v1 and writes v2', async (t) => {
  const secret = { token: 'abc', nested: { n: 1 } };

  await t.test('a fresh write is v2 under the rocky discriminator', () => {
    const e = encryptValue('br_aaaaaaaaaaaa', 'transcript', secret);
    assert.equal(envelopeVersion(e), 2);
    assert.equal(e._rockyVault, 2);
    assert.equal(e._riftVault, undefined);
    assert.deepEqual(decryptValue('br_aaaaaaaaaaaa', 'transcript', e), secret);
  });

  await t.test('a v1 envelope written before the rename still decrypts', () => {
    const legacy = writeLegacyEnvelope('br_aaaaaaaaaaaa', 'transcript', secret);
    assert.ok(isEncryptedEnvelope(legacy));
    assert.ok(isLegacyEnvelope(legacy));
    assert.deepEqual(decryptValue('br_aaaaaaaaaaaa', 'transcript', legacy), secret);
  });

  await t.test('the AAD is still bound to tenant and record', () => {
    const e = encryptValue('br_aaaaaaaaaaaa', 'transcript', secret);
    assert.throws(() => decryptValue('br_bbbbbbbbbbbb', 'transcript', e), /authentication failed/);
    assert.throws(() => decryptValue('br_aaaaaaaaaaaa', 'llm-auth', e), /authentication failed/);
  });

  await t.test('a v1 envelope is equally bound', () => {
    const legacy = writeLegacyEnvelope('br_aaaaaaaaaaaa', 'transcript', secret);
    assert.throws(() => decryptValue('br_bbbbbbbbbbbb', 'transcript', legacy), /authentication failed/);
  });

  await t.test('a v1 envelope re-encrypts to v2 with identical plaintext', () => {
    const legacy = writeLegacyEnvelope('br_aaaaaaaaaaaa', 'composio-mcp', secret);
    const plain = decryptValue('br_aaaaaaaaaaaa', 'composio-mcp', legacy);
    const migrated = encryptValue('br_aaaaaaaaaaaa', 'composio-mcp', plain);
    assert.equal(envelopeVersion(migrated), 2);
    assert.deepEqual(decryptValue('br_aaaaaaaaaaaa', 'composio-mcp', migrated), secret);
  });

  await t.test('a non-envelope is rejected', () => {
    assert.equal(envelopeVersion({ _riftVault: 2 }), null);
    assert.equal(envelopeVersion({ _rockyVault: 1 }), null);
    assert.equal(isEncryptedEnvelope({ hello: 'world' }), false);
  });
});
