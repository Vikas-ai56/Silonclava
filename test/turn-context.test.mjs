import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTenantStore } from '../src/tenant-data/store.mjs';
import { recordInboundAndQueueTurn } from '../src/tenant-data/queue-store.mjs';
import {
  quotedMessage,
  quotedReplyPreamble,
  toolAvailabilityPreamble,
} from '../src/tenant-data/turn-context.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_tctx_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function inbound(store, body, extra = {}) {
  return recordInboundAndQueueTurn(store, {
    conversationId: store.tenantId,
    channel: 'whatsapp',
    channelAccount: '+919632754524',
    body,
    ...extra,
  });
}

describe('quoted reply context', () => {
  it('stores the provider reply reference and resolves the quoted text', () => {
    const store = openTenantStore(freshTenant('quote'));
    try {
      inbound(store, 'Please prepare the Series B term sheet', { externalMessageId: 'SMold' });
      inbound(store, 'any update?', { externalMessageId: 'SMnew', replyToExternalId: 'SMold' });

      const q = quotedMessage(store, store.tenantId, 'SMold');
      assert.equal(q.found, true);
      assert.equal(q.direction, 'inbound');
      assert.match(q.text, /Series B term sheet/);

      const pre = quotedReplyPreamble(q);
      assert.match(pre, /replying directly to/);
      assert.match(pre, /Series B term sheet/);
    } finally {
      store.db.close();
    }
  });

  it('says only that the quote is not in the record, never why', () => {
    const pre = quotedReplyPreamble({ found: false, externalMessageId: 'MM123' });
    assert.match(pre, /not in this conversation's record/);
    // The reason was wrong in production: the target was a file the agent sent,
    // whose provider id we never stored — nothing to do with the 7-day window.
    assert.doesNotMatch(pre, /7 days/);
    assert.doesNotMatch(pre, /older/);
    assert.match(pre, /ask what they are referring to/);
  });

  it('returns nothing when the message is not a reply', () => {
    const store = openTenantStore(freshTenant('noreply'));
    try {
      assert.equal(quotedMessage(store, store.tenantId, null), null);
      assert.equal(quotedReplyPreamble(null), '');
    } finally {
      store.db.close();
    }
  });
});

describe('tool availability preamble', () => {
  it('tells the agent not to fake external work when nothing is connected', () => {
    const pre = toolAvailabilityPreamble({ toolkits: [], sidecarHealthy: true });
    assert.match(pre, /no external accounts connected/i);
    assert.match(pre, /do not imply it succeeded/);
    // Not "reply connect <account>" any more: keyword matching was removed, so
    // telling the user to type a command sends them into a path that no longer
    // exists. The agent connects it for them.
    assert.match(pre, /connect it for them/);
  });

  it('distinguishes "none connected" from "tools are unavailable"', () => {
    const down = toolAvailabilityPreamble({ toolkits: ['gmail'], sidecarHealthy: false });
    assert.match(down, /unavailable/i);
    assert.doesNotMatch(down, /no external accounts connected/i);
  });

  // The agent told a WhatsApp user to "restart OpenClaw's gateway to bring
  // composio back online" (observed 2026-09-20). An end user cannot do that and
  // should never learn those names exist.
  // The rule must NOT live inside the tool preamble: with tools connected that
  // preamble is empty, and the agent then told a WhatsApp user it would "walk
  // through OpenClaw composio settings" (observed live 2026-09-20).

  // Silence let a stale transcript win: the agent refused a calendar request
  // while holding six working calendar tools (observed live 2026-09-20).
  it('states connected tools in the present tense and overrides stale history', () => {
    const pre = toolAvailabilityPreamble({ toolkits: ['googlecalendar'], sidecarHealthy: true });
    assert.match(pre, /Connected and working right now: googlecalendar/);
    assert.match(pre, /ignore anything earlier in this conversation/);
    assert.notEqual(pre, '', 'silence lets the replayed transcript decide');
  });
});

describe('connectable toolkits in the preamble', () => {
  it('states what can be connected, not only what is connected', () => {
    const p = toolAvailabilityPreamble({ toolkits: ['gmail'], connectable: ['linear', 'googledrive'] });
    assert.match(p, /Connected and working right now: gmail/);
    assert.match(p, /linear, googledrive/);
    assert.match(p, /connect_account/);
  });

  it('never lets a connectable toolkit be described as unavailable', () => {
    // The live failure: holding gmail/calendar/asana and asked for Linear, the
    // agent answered "not available in your setup" and never called the tool.
    const p = toolAvailabilityPreamble({ toolkits: ['gmail', 'asana'], connectable: ['linear'] });
    assert.match(p, /not in your setup/);
    assert.ok(p.indexOf('linear') > p.indexOf('Connected and working'));
  });

  it('makes no offer when nothing is connectable', () => {
    assert.doesNotMatch(toolAvailabilityPreamble({ toolkits: ['gmail'], connectable: [] }), /connect_account/);
  });

  it('makes no offer when the connector is down', () => {
    const p = toolAvailabilityPreamble({ toolkits: [], connectable: ['linear'], sidecarHealthy: false });
    assert.doesNotMatch(p, /connect_account/);
  });
});
