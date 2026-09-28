import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn, claimNextTurn } from '../src/tenant-data/queue-store.mjs';
import { saveResponse, recordMessageParts } from '../src/tenant-data/delivery-store.mjs';
import { quotedMessage } from '../src/tenant-data/turn-context.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_part_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function seedTurn(store) {
  recordInboundAndQueueTurn(store, {
    conversationId: 'c1',
    channel: 'whatsapp',
    channelAccount: '+6591234567',
    externalMessageId: 'SMinbound1',
    body: 'tell me something long',
    recipient: '+6591234567',
    at: new Date().toISOString(),
  });
  return claimNextTurn(store, { runtimeId: 'r1', generation: 1 });
}

describe('a reply to any delivered part resolves to the whole reply', () => {
  it('finds the reply through message_parts, not just the first id', () => {
    const id = freshTenant('resolve');
    const store = openTenantStore(id);
    try {
      const turn = seedTurn(store);
      const text = 'the full committed reply, delivered in four parts';
      const saved = saveResponse(store, turn.id, text);

      // What the provider actually created: four messages, four ids.
      const partIds = ['SMpart0', 'SMpart1', 'SMpart2', 'SMpart3'];
      assert.equal(recordMessageParts(store, saved.messageId, partIds), 4);

      // Before this fix only one id was stored, so three of four replies missed.
      for (const pid of partIds) {
        const quoted = quotedMessage(store, 'c1', pid);
        assert.equal(quoted.found, true, `reply to ${pid} must resolve`);
        assert.equal(quoted.text, text);
        assert.equal(quoted.direction, 'outbound');
      }
    } finally {
      store.close?.();
    }
  });

  it('an unknown provider id is still a clean miss', () => {
    const id = freshTenant('miss');
    const store = openTenantStore(id);
    try {
      const turn = seedTurn(store);
      const saved = saveResponse(store, turn.id, 'short reply');
      recordMessageParts(store, saved.messageId, ['SMknown']);
      const quoted = quotedMessage(store, 'c1', 'SMneverSeen');
      assert.equal(quoted.found, false);
      assert.equal(quoted.externalMessageId, 'SMneverSeen');
    } finally {
      store.close?.();
    }
  });

  it('recording the same parts twice is harmless', () => {
    const id = freshTenant('idem');
    const store = openTenantStore(id);
    try {
      const turn = seedTurn(store);
      const saved = saveResponse(store, turn.id, 'reply');
      assert.equal(recordMessageParts(store, saved.messageId, ['SMa', 'SMb']), 2);
      assert.equal(recordMessageParts(store, saved.messageId, ['SMa', 'SMb']), 0);
      assert.equal(quotedMessage(store, 'c1', 'SMb').found, true);
    } finally {
      store.close?.();
    }
  });

  it('a send that produced no provider id records nothing', () => {
    const id = freshTenant('none');
    const store = openTenantStore(id);
    try {
      const turn = seedTurn(store);
      const saved = saveResponse(store, turn.id, 'reply');
      assert.equal(recordMessageParts(store, saved.messageId, [null, undefined, '']), 0);
    } finally {
      store.close?.();
    }
  });
});
