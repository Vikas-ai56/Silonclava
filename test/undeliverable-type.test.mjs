import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deliverableBy, deliverWorkspaceFile } from '../src/outbox.mjs';

const whatsapp = { capabilities: { mediaTypes: ['application/pdf', 'image/png'] } };

describe('a file the provider will not carry is refused, not reported as sent', () => {
  it('knows which types this channel accepts', () => {
    assert.equal(deliverableBy(whatsapp, 'report.pdf').ok, true);
    assert.equal(deliverableBy(whatsapp, 'notes.md').ok, false,
      'Twilio returns 200 for a text/plain media url and the user receives nothing');
    assert.equal(deliverableBy(whatsapp, 'data.csv').ok, false);
  });

  it('the direct send path refuses rather than minting a link', async () => {
    let sent = false;
    const channel = { ...whatsapp, sendMedia: async () => { sent = true; return {}; } };
    await assert.rejects(
      () => deliverWorkspaceFile(channel, 'br_x', '+6591234567', 'notes.md'),
      (err) => err.code === 'UNDELIVERABLE_TYPE',
      'this path had no allowlist check at all, so a .md was "delivered" into silence',
    );
    assert.equal(sent, false, 'nothing must reach the provider');
  });

  it('still sends a type the provider does accept', async () => {
    const calls = [];
    const channel = {
      ...whatsapp,
      sendMedia: async (to, url) => { calls.push(url); return { providerMessageId: 'MM1' }; },
    };
    process.env.ROCKY_MEDIA_SIGNING_KEY ||= 'test-signing-key-for-undeliverable';
    const out = await deliverWorkspaceFile(channel, 'br_x', '+6591234567', 'report.pdf');
    assert.equal(calls.length, 1);
    assert.equal(out.file, 'report.pdf');
  });

  it('a channel that declares no allowlist is not second-guessed', () => {
    assert.equal(deliverableBy({ capabilities: {} }, 'notes.md').ok, true,
      'only refuse when the channel actually told us what it accepts');
  });
});
