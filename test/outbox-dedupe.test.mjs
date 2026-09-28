import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// mediaLinkFor refuses to mint a link without one; the dedupe runs before it,
// but without this every send fails and the test would pass for the wrong reason.
process.env.ROCKY_MEDIA_SIGNING_KEY ||= 'test-signing-key-for-outbox-dedupe';

import { deliverOutbox, OUTBOX_DIR, SENT_DIR } from '../src/outbox.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
function freshTenant(tag) {
  const id = `br_dedupe_${tag}_${process.pid}`;
  ids.push(id);
  const ws = path.join(TENANTS_DIR, id, 'workspace', OUTBOX_DIR);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  return { id, outbox: ws };
}
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});

function channelSpy() {
  const sent = [];
  return {
    sent,
    capabilities: { mediaTypes: ['application/pdf', 'image/png'] },
    async sendMedia(to, url) {
      sent.push(url);
      return { providerMessageId: `MM${sent.length}` };
    },
  };
}

describe('the outbox will not deliver the same bytes twice', () => {
  it('three copies under different names become one send', async () => {
    const { id, outbox } = freshTenant('three');
    const bytes = Buffer.from('%PDF-1.4 the same diagram');
    // What an agent unsure whether a send landed actually does.
    fs.writeFileSync(path.join(outbox, 'diagram.pdf'), bytes);
    fs.writeFileSync(path.join(outbox, 'diagram-v2.pdf'), bytes);
    fs.writeFileSync(path.join(outbox, 'diagram-final.pdf'), bytes);

    const ch = channelSpy();
    const out = await deliverOutbox(ch, id, '+6591234567');

    assert.equal(ch.sent.length, 1, 'the user must receive it once');
    assert.equal(out.delivered.length, 1);
    assert.equal(out.duplicates.length, 2, 'the other two are recorded as duplicates');
    // Nothing is left behind to be re-delivered on the next turn.
    assert.deepEqual(fs.readdirSync(outbox).filter((f) => f.endsWith('.pdf')), []);
    assert.equal(
      fs.readdirSync(path.join(TENANTS_DIR, id, 'workspace', SENT_DIR)).length,
      3,
      'all three still move out of the way',
    );
  });

  it('a later turn re-writing the same file does not deliver it again', async () => {
    const { id, outbox } = freshTenant('later');
    const bytes = Buffer.from('%PDF-1.4 report');
    fs.writeFileSync(path.join(outbox, 'report.pdf'), bytes);

    const ch = channelSpy();
    await deliverOutbox(ch, id, '+6591234567');
    assert.equal(ch.sent.length, 1);

    // The agent writes it again on a later turn.
    fs.writeFileSync(path.join(outbox, 'report.pdf'), bytes);
    const again = await deliverOutbox(ch, id, '+6591234567');
    assert.equal(ch.sent.length, 1, 'still once — the bytes already went out');
    assert.equal(again.duplicates.length, 1);
  });

  it('genuinely different content still goes out', async () => {
    const { id, outbox } = freshTenant('different');
    fs.writeFileSync(path.join(outbox, 'a.pdf'), Buffer.from('%PDF-1.4 first'));
    fs.writeFileSync(path.join(outbox, 'b.pdf'), Buffer.from('%PDF-1.4 second'));

    const ch = channelSpy();
    const out = await deliverOutbox(ch, id, '+6591234567');
    assert.equal(ch.sent.length, 2, 'dedupe must not swallow a real second file');
    assert.equal(out.duplicates.length, 0);
  });

  it('a revised file with the same name is a different file', async () => {
    const { id, outbox } = freshTenant('revised');
    fs.writeFileSync(path.join(outbox, 'draft.pdf'), Buffer.from('%PDF-1.4 v1'));
    const ch = channelSpy();
    await deliverOutbox(ch, id, '+6591234567');

    // Same name, corrected content — the user must get the correction.
    fs.writeFileSync(path.join(outbox, 'draft.pdf'), Buffer.from('%PDF-1.4 v2 corrected'));
    const out = await deliverOutbox(ch, id, '+6591234567');
    assert.equal(ch.sent.length, 2, 'a real revision must still reach the user');
    assert.equal(out.duplicates.length, 0);
  });
});
