import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkForWhatsApp, WHATSAPP_BODY_LIMIT } from '../src/whatsapp-chunk.mjs';

test('a reply within the limit is one part', () => {
  assert.deepEqual(chunkForWhatsApp('hello'), ['hello']);
  assert.deepEqual(chunkForWhatsApp(''), []);
  assert.deepEqual(chunkForWhatsApp('   '), []);
});

test('every part fits, and nothing is lost', () => {
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(120)}`).join('\n\n');
  const parts = chunkForWhatsApp(body);
  assert.ok(parts.length > 1, 'a 5k body must be split');
  for (const p of parts) assert.ok(p.length <= WHATSAPP_BODY_LIMIT, `part too long: ${p.length}`);
  // Joining on the boundary we split on returns the original.
  assert.equal(parts.join('\n\n'), body);
});

test('a word is never cut in half', () => {
  const body = `${'alpha '.repeat(500)}`.trim();
  for (const p of chunkForWhatsApp(body)) {
    assert.ok(p.length <= WHATSAPP_BODY_LIMIT);
    assert.ok(!/alph$|^ha\b/.test(p), 'split mid-word');
  }
});

test('a single unbroken run longer than the limit still fits', () => {
  const parts = chunkForWhatsApp('y'.repeat(4000));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= WHATSAPP_BODY_LIMIT);
  assert.equal(parts.join(''), 'y'.repeat(4000));
});

test('a fenced code block that fits is kept whole', () => {
  const code = '```\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n```';
  const body = `${'lead '.repeat(200)}\n\n${code}\n\n${'tail '.repeat(200)}`;
  const parts = chunkForWhatsApp(body);
  const holder = parts.filter((p) => p.includes('```'));
  assert.equal(holder.length, 1, 'the fence must not be spread across parts');
  assert.equal((holder[0].match(/```/g) || []).length, 2, 'both fence markers travel together');
});

test('the limit leaves room under WhatsApp\'s own 1600', () => {
  // Above this Twilio delivers several messages whose ids we never see, which
  // is the bug this module exists to prevent.
  assert.ok(WHATSAPP_BODY_LIMIT < 1600);
});
