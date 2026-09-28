import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { speakerLabel, transcriptLine, OUTBOUND_LABEL } from '../src/tenant-data/transcript-label.mjs';

test('replayed history never claims the model authored a platform message', async (t) => {
  await t.test('an outbound line is third person, not second', () => {
    assert.equal(speakerLabel('inbound'), 'User');
    assert.equal(speakerLabel('outbound'), 'Model response');
    assert.doesNotMatch(OUTBOUND_LABEL, /^You$/);
    assert.equal(transcriptLine({ direction: 'outbound', text: 'hi' }), 'Model response: hi');
    assert.equal(transcriptLine({ direction: 'inbound', text: 'hi' }), 'User: hi');
  });

  await t.test('both renderers share one label, so they cannot drift apart', () => {
    for (const file of ['src/tenant-data/context-store.mjs', 'src/tenant-data/turn-context.mjs']) {
      const src = fs.readFileSync(file, 'utf8');
      assert.match(src, /transcriptLine/, `${file} must render through the shared label`);
      assert.doesNotMatch(src, /'User' : 'You'/, `${file} must not inline a label`);
    }
  });

  await t.test('the quoted-reply preamble does not attribute an outbound to the model', () => {
    const src = fs.readFileSync('src/tenant-data/turn-context.mjs', 'utf8');
    assert.doesNotMatch(src, /your earlier reply/);
  });
});

test('the guardrail block tells the agent the platform writes in its thread', async (t) => {
  const agents = fs.readFileSync('org/templates/workspace/AGENTS.md', 'utf8');
  const provenance = agents.slice(agents.indexOf('<provenance>'), agents.indexOf('</provenance>'));

  await t.test('it does not claim platform messages stay out of memory', () => {
    assert.ok(provenance.length > 0, 'provenance block must exist');
    assert.doesNotMatch(provenance, /never enter your memory/);
  });

  await t.test('it says they appear in replayed history', () => {
    assert.match(provenance, /replayed history/);
    assert.match(provenance, /not a forgery/);
  });

  await t.test('it still forbids calling a platform message an attack', () => {
    assert.match(provenance.replace(/\s+/g, " "), /phishing or an attack/);
  });
});
