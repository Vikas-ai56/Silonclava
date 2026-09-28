import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchConnectIntent } from '../src/connect.mjs';

describe('explicit connection intents', () => {
  // Provider login stays deterministic because it bootstraps the very model
  // that would otherwise interpret the request: if Claude is not connected yet
  // there is nothing to route the intent.
  it('routes provider login deterministically', () => {
    assert.deepEqual(matchConnectIntent('connect claude'), { type: 'connect-llm', provider: 'claude' });
    assert.deepEqual(matchConnectIntent('link anthropic'), { type: 'connect-llm', provider: 'claude' });
    assert.deepEqual(matchConnectIntent('connect codex'), { type: 'connect-llm', provider: 'codex' });
  });

  it('leaves every external account to the agent tool', () => {
    for (const phrase of [
      'connect gmail', 'link calendar', 'connect asana', 'connect outlook',
      'check my inbox', 'create a calendar event',
    ]) {
      assert.equal(matchConnectIntent(phrase), null, `${phrase} must not be regex-routed`);
    }
  });
});
