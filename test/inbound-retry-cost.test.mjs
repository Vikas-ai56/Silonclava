import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { alreadyAccepted, recordInboundAndQueueTurn } from '../src/tenant-data/queue-store.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_retrycost_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

const inbound = (store, externalMessageId, body) => recordInboundAndQueueTurn(store, {
  conversationId: 'c1',
  channel: 'whatsapp',
  channelAccount: '+6591234567',
  externalMessageId,
  body,
  recipient: '+6591234567',
  at: new Date().toISOString(),
});

describe('a provider retry must not repeat paid work', () => {
  it('reports a message it has already accepted', () => {
    const id = freshTenant('seen');
    const store = openTenantStore(id);
    try {
      const key = { channel: 'whatsapp', channelAccount: '+6591234567', externalMessageId: 'SMfoo' };
      assert.equal(alreadyAccepted(store, key), false, 'nothing accepted yet');

      inbound(store, 'SMfoo', 'a voice note');
      assert.equal(alreadyAccepted(store, key), true,
        'Twilio retries the webhook; the second delivery must be recognisable BEFORE '
        + 'the media is downloaded and sent to a paid transcription provider');
    } finally { store.close?.(); }
  });

  it('does not confuse a different message, sender, or channel', () => {
    const id = freshTenant('distinct');
    const store = openTenantStore(id);
    try {
      inbound(store, 'SMone', 'first');
      const base = { channel: 'whatsapp', channelAccount: '+6591234567' };
      assert.equal(alreadyAccepted(store, { ...base, externalMessageId: 'SMtwo' }), false,
        'a genuinely new message must still be processed');
      assert.equal(
        alreadyAccepted(store, { ...base, channelAccount: '+6599999999', externalMessageId: 'SMone' }),
        false,
        'the same provider id from another conversation is another message',
      );
    } finally { store.close?.(); }
  });

  it('treats a message with no provider id as new, rather than silently dropping it', () => {
    const id = freshTenant('noid');
    const store = openTenantStore(id);
    try {
      assert.equal(
        alreadyAccepted(store, {
          channel: 'whatsapp', channelAccount: '+6591234567', externalMessageId: null,
        }),
        false,
        'no id means we cannot prove it is a retry — dropping it would lose a real message',
      );
    } finally { store.close?.(); }
  });
});
