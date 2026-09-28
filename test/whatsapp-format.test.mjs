import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toWhatsAppText } from '../src/whatsapp-format.mjs';

/**
 * WhatsApp renders *bold*, not **bold**. A model writing Markdown produced
 * visible asterisks in a real reply (observed 2026-09-20):
 *   "1. *Composio isn't running* — the underlying connector needs to be active"
 */
describe('whatsapp text formatting', () => {
  it('converts Markdown bold to WhatsApp bold without leaving asterisks', () => {
    const out = toWhatsAppText('**Composio** is down');
    assert.equal(out, '*Composio* is down');
    assert.doesNotMatch(out, /\*\*/);
  });

  it('turns headings into bold lines', () => {
    assert.equal(toWhatsAppText('## Blockers\n\nbody'), '*Blockers*\n\nbody');
  });

  it('rewrites bullets to a character WhatsApp renders', () => {
    assert.equal(toWhatsAppText('- one\n- two'), '• one\n• two');
    assert.equal(toWhatsAppText('* one\n* two'), '• one\n• two');
  });

  it('keeps numbered lists as-is', () => {
    assert.equal(toWhatsAppText('1. first\n2. second'), '1. first\n2. second');
  });

  it('flattens links to something tappable', () => {
    assert.equal(
      toWhatsAppText('see [the docs](https://x.test/d)'),
      'see the docs: https://x.test/d',
    );
    assert.equal(toWhatsAppText('[https://x.test](https://x.test)'), 'https://x.test');
  });

  it('strips inline code backticks but preserves fenced blocks', () => {
    assert.equal(toWhatsAppText('run `npm test` now'), 'run npm test now');
    assert.equal(toWhatsAppText('```js\nconst a = 1;\n```'), '```\nconst a = 1;\n```');
  });

  it('does not mangle bold inside a fenced block', () => {
    assert.equal(toWhatsAppText('```\n**not bold**\n```'), '```\n**not bold**\n```');
  });

  it('drops horizontal rules and collapses blank runs', () => {
    assert.equal(toWhatsAppText('a\n\n---\n\nb'), 'a\n\nb');
  });

  it('leaves plain text untouched and handles empty input', () => {
    assert.equal(toWhatsAppText('just a normal reply'), 'just a normal reply');
    assert.equal(toWhatsAppText(''), '');
    assert.equal(toWhatsAppText(null), '');
    assert.equal(toWhatsAppText('   \n  '), '');
  });

  it('does not convert a lone asterisk or multiplication', () => {
    assert.equal(toWhatsAppText('2 * 3 = 6'), '2 * 3 = 6');
  });
});
