import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mediaKind, extensionFor, transcriptBodyFor, attachmentPreamble } from '../src/inbound-media.mjs';

/**
 * A transcript is encrypted text. It cannot hold bytes, so each kind of media
 * gets the representation that is true for it — the one case where the stored
 * text really is what the user said is a transcribed voice note.
 */
describe('inbound media representation', () => {
  it('classifies by content type', () => {
    assert.equal(mediaKind('image/jpeg'), 'image');
    assert.equal(mediaKind('audio/ogg'), 'audio');
    assert.equal(mediaKind('video/mp4'), 'video');
    assert.equal(mediaKind('application/pdf'), 'document');
    assert.equal(mediaKind(''), 'document');
    assert.equal(extensionFor('image/png'), '.png');
    assert.equal(extensionFor('application/octet-stream'), '');
  });

  it('stores a voice note transcript AS the message body, so search finds it', () => {
    const body = transcriptBodyFor({
      caption: '',
      attachments: [{ kind: 'audio', file: 'v.ogg', transcript: 'prepare the term sheet by friday' }],
    });
    assert.match(body, /^prepare the term sheet by friday/);
    assert.match(body, /\[voice note: v\.ogg\]/);
  });

  it('never invents a caption for an image', () => {
    const body = transcriptBodyFor({ caption: '', attachments: [{ kind: 'image', file: 'a.jpg' }] });
    assert.equal(body, '[image: a.jpg]');
    const withCaption = transcriptBodyFor({
      caption: 'look at this', attachments: [{ kind: 'image', file: 'a.jpg' }],
    });
    assert.equal(withCaption, 'look at this\n[image: a.jpg]');
  });

  it('records a document by name, type and size — not as the user speaking', () => {
    const body = transcriptBodyFor({
      caption: '', attachments: [{ kind: 'document', file: 'n.pdf', contentType: 'application/pdf', bytes: 1234 }],
    });
    assert.match(body, /\[document: n\.pdf, application\/pdf, 1234 bytes\]/);
  });

  it('says plainly when a voice note could not be transcribed', () => {
    const body = transcriptBodyFor({ caption: '', attachments: [{ kind: 'audio', file: 'v.ogg' }] });
    assert.match(body, /not transcribed/);
    const pre = attachmentPreamble([{ kind: 'audio', file: 'v.ogg' }]);
    assert.match(pre, /say so rather than guessing/);
  });

  it('tells the agent where each file is and what it may do with it', () => {
    const pre = attachmentPreamble([
      { kind: 'image', file: 'a.jpg' },
      { kind: 'video', file: 'c.mp4' },
    ]);
    assert.match(pre, /\/tenant\/workspace\/inbox\/a\.jpg/);
    assert.match(pre, /describe what is actually there/);
    assert.match(pre, /you cannot watch it/);
  });

  it('is silent when nothing was attached', () => {
    assert.equal(attachmentPreamble([]), '');
    assert.equal(transcriptBodyFor({ caption: 'just text', attachments: [] }), 'just text');
  });
});

describe('a voice note that was too long says so', () => {
  it('tells the agent the limit, so the user can send a shorter one', () => {
    const line = attachmentPreamble([
      { kind: 'audio', file: 'note.ogg', transcript: null, transcriptFailure: 'too-long' },
    ]);
    assert.match(line, /30 seconds/,
      'the reason was discarded, so the user was told only "unavailable" and had no way to '
      + 'recover except by guessing');
    assert.match(line, /do not guess/);
  });

  it('still refuses to guess when the reason is unknown', () => {
    const line = attachmentPreamble([
      { kind: 'audio', file: 'note.ogg', transcript: null, transcriptFailure: 'unavailable' },
    ]);
    assert.match(line, /say so rather than guessing/);
    assert.doesNotMatch(line, /30 seconds/, 'do not claim a cause we did not observe');
  });
});
