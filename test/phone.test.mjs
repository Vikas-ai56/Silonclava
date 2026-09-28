import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, tenantIdFromPhone } from '../src/phone.mjs';

describe('phone', () => {
  it('normalizes E.164-ish input to digits + jid', () => {
    const n = normalizePhone('+1 555 000 1111');
    assert.equal(n.phone, '15550001111');
    assert.equal(n.jid, '15550001111@s.whatsapp.net');
  });

  it('rejects too-short numbers', () => {
    assert.throws(() => normalizePhone('123'), /valid WhatsApp number/);
  });

  it('tenantIdFromPhone strips non-digits', () => {
    assert.equal(tenantIdFromPhone('+65-9123-4567'), '6591234567');
  });
});
