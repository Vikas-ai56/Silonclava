import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  voiceReplyConfigured, replyIsSpeakable, turnHadVoiceNote,
} from '../src/speech/voice-reply.mjs';
import { MAX_TTS_CHARACTERS } from '../src/speech/sarvam.mjs';

describe('a spoken reply answers a spoken message', () => {
  it('speaks only when the user actually sent a voice note', () => {
    assert.equal(turnHadVoiceNote([{ kind: 'audio' }]), true);
    assert.equal(turnHadVoiceNote([{ kind: 'image' }, { kind: 'document' }]), false,
      'a photo is not a request to be spoken to');
    assert.equal(turnHadVoiceNote([]), false);
    assert.equal(turnHadVoiceNote(undefined), false, 'a text-only turn must not synthesize');
  });

  it('does not speak a voice note we failed to fetch', () => {
    assert.equal(turnHadVoiceNote([{ kind: 'audio', failed: true }]), false,
      'we never heard it, so answering by voice claims a conversation that did not happen');
  });

  it('refuses to speak a reply past the provider limit rather than truncating it', () => {
    assert.equal(replyIsSpeakable('x'.repeat(MAX_TTS_CHARACTERS)), true);
    assert.equal(replyIsSpeakable('x'.repeat(MAX_TTS_CHARACTERS + 1)), false,
      'a half-spoken answer is worse than a written one');
  });

  it('treats an empty reply as nothing to speak', () => {
    assert.equal(replyIsSpeakable(''), false);
    assert.equal(replyIsSpeakable('   '), false);
    assert.equal(replyIsSpeakable(null), false);
  });

  it('is disabled entirely when no key is configured', () => {
    const before = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    try {
      assert.equal(voiceReplyConfigured(), false,
        'without a provider the turn must fall back to text, never to silence');
    } finally {
      if (before !== undefined) process.env.SARVAM_API_KEY = before;
    }
  });
});

describe('the spoken reply does not pin its own model', () => {
  it('uses the client default so a deprecation is fixed in one place', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('../src/speech/voice-reply.mjs', import.meta.url), 'utf8'));
    assert.ok(!/bulbul:/.test(source),
      'a hard-coded model here silently diverged from the client and every spoken reply '
      + 'failed with "bulbul:v2 has been deprecated"');
  });
});

describe('an optional nicety must not sit on the critical path', () => {
  it('sends the written answer before attempting synthesis', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../src/router.mjs', import.meta.url), 'utf8');
    const deliver = src.indexOf('await deliverResponse(');
    const speak = src.indexOf('await speakReply(');
    assert.ok(deliver > 0 && speak > 0, 'both calls exist');
    assert.ok(deliver < speak,
      'speakReply ran first, so a Sarvam outage that hangs rather than refuses delayed the '
      + "user's WRITTEN answer by up to the full retry ladder");
  });
});
