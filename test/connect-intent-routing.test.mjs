import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchConnectIntent } from '../src/connect.mjs';
import { AGENT_TOOLS } from '../src/agent-mcp.mjs';

function requireAgentTools() { return { AGENT_TOOLS }; }

/**
 * "Connect calendar" reached the model instead of the connect flow, and the
 * model invented an authorisation prompt that does not exist (observed
 * 2026-09-20). Cause: the router passes the assembled prompt — preambles plus
 * replayed transcript — as `text`, and every connect intent is anchored with
 * `^`. So the command never matched for any tenant needing a context replay.
 */
describe('connect intent routing', () => {
  it('matches the user text and not the assembled prompt', () => {
    assert.deepEqual(matchConnectIntent('connect claude'), {
      type: 'connect-llm',
      provider: 'claude',
    });
    const assembled = 'You are talking to a person on WhatsApp, not an operator.\n\n---\nconnect claude';
    assert.equal(matchConnectIntent(assembled), null, 'anchored intents cannot survive a preamble');
  });

  it('router forwards the raw text separately from the model prompt', () => {
    const router = fs.readFileSync('src/router.mjs', 'utf8');
    assert.match(router, /commandText: text/, 'router must pass the raw user text');
    const onboarding = fs.readFileSync('src/onboarding.mjs', 'utf8');
    assert.match(onboarding, /commandText: msg\.commandText/, 'onboarding must forward it');
    const agent = fs.readFileSync('src/agent.mjs', 'utf8');
    assert.match(
      agent,
      /const said = String\(commandText \?\? trimmed\)/,
      'agent must derive the raw user words',
    );
    assert.match(agent, /matchConnectIntent\(said\)/, 'command matching must use them');
  });

  // External accounts are deliberately NOT phrase-matched any more: the agent
  // has connect_account as a tool, so any phrasing works. Keeping a regex here
  // would mean two paths that must agree, and only one of them understands
  // "hook up my calendar".
  it('leaves external accounts to the agent tool, not a regex', () => {
    for (const phrase of ['connect gmail', 'connect calendar', 'connect asana', 'connect outlook']) {
      assert.equal(matchConnectIntent(phrase), null, `${phrase} must reach the model, not a regex`);
    }
    const { AGENT_TOOLS } = requireAgentTools();
    assert.ok(AGENT_TOOLS.some((t) => t.name === 'connect_account'),
      'the capability must exist as a tool instead');
  });
});
