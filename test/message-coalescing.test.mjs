import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn } from '../src/tenant-data/queue-store.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_coal_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => { for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true }); });

/**
 * Two messages sent back to back produced "Got it — finishing your previous
 * message, then I'll take this", then a reply that answered only one of them
 * (observed 2026-09-20). The ack described a queue that does not exist: a
 * coalesced message joins the turn that is already pending, so both are
 * answered together or not at all.
 */
describe('message coalescing', () => {
  it('joins a pending turn rather than creating a second one', () => {
    const store = openTenantStore(freshTenant('join'));
    try {
      const first = recordInboundAndQueueTurn(store, {
        conversationId: store.tenantId, channel: 'whatsapp', channelAccount: '+91', body: 'one',
      });
      const second = recordInboundAndQueueTurn(store, {
        conversationId: store.tenantId, channel: 'whatsapp', channelAccount: '+91', body: 'two',
      });
      assert.equal(second.coalescedInto, true);
      assert.equal(second.turnId, first.turnId, 'both messages belong to one turn');
      const rows = store.db.prepare('SELECT COUNT(*) c FROM turns').get();
      assert.equal(rows.c, 1, 'no second turn is queued behind it');
    } finally {
      store.db.close();
    }
  });

  it('keeps every message as its own ledger row', () => {
    const store = openTenantStore(freshTenant('rows'));
    try {
      for (const body of ['first', 'second', 'third']) {
        recordInboundAndQueueTurn(store, {
          conversationId: store.tenantId, channel: 'whatsapp', channelAccount: '+91', body,
        });
      }
      const n = store.db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='inbound'").get();
      assert.equal(n.c, 3, 'coalescing must never lose an individual message');
    } finally {
      store.db.close();
    }
  });

  it('numbers a coalesced turn so the agent answers all of it', () => {
    const router = fs.readFileSync('src/router.mjs', 'utf8');
    assert.match(router, /Answer all of them/, 'the prompt must say there were several messages');
    assert.match(router, /\[\$\{i \+ 1\}\]/, 'each message must be numbered');
    assert.doesNotMatch(router, /finishing your previous message/, 'the misleading ack must be gone');
  });
});
