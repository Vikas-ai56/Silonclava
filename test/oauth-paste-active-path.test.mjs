import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripNoReplySentinel } from '../src/openclaw/tenant-openclaw.mjs';

// Live failure 2026-09-22, tenant ACTIVE: the pasted CODE#STATE was checked
// against the ASSEMBLED prompt, which always carries a preamble, so it matched
// no pending record, fell through to the model, and the model answered
// NO_REPLY — which reached the user verbatim. The AUTH_PENDING path in
// onboarding.mjs had been fixed; this one had not, and no test covered it.
test('the OAuth paste is matched on the user words on every path', async (t) => {
  const agent = fs.readFileSync('src/agent.mjs', 'utf8');

  await t.test('agent.mjs derives the user words once', () => {
    assert.match(agent, /const said = String\(commandText \?\? trimmed\)\.trim\(\);/);
  });

  await t.test('detection and payload both use them, never the prompt', () => {
    assert.match(agent, /canComplete\(said\)/);
    assert.match(agent, /complete\(\{ code: said \}\)/);
    assert.doesNotMatch(agent, /canComplete\(trimmed\)/);
    assert.doesNotMatch(agent, /code: trimmed/);
  });

  await t.test('the model still receives the full assembled prompt', () => {
    assert.match(agent, /runtime\(\)\.turn\(trimmed\)/);
  });

  await t.test('onboarding.mjs keeps its own fix', () => {
    const src = fs.readFileSync('src/onboarding.mjs', 'utf8');
    const branch = src.slice(src.indexOf("if (tenant.state === 'AUTH_PENDING')"));
    assert.doesNotMatch(branch.slice(0, branch.indexOf('runAgentTurn')), /\?\s*msg\.text/);
  });
});

test('the NO_REPLY sentinel never reaches the user', async (t) => {
  await t.test('it is recognised in the shapes OpenClaw emits', () => {
    for (const v of ['NO_REPLY', 'no_reply', ' NO_REPLY ', 'NO REPLY', 'no-reply', 'NO_REPLY.']) {
      assert.equal(stripNoReplySentinel(v), '', `${JSON.stringify(v)} must be suppressed`);
    }
  });

  await t.test('a real reply is untouched, including one that mentions it', () => {
    assert.equal(stripNoReplySentinel('  hello  '), 'hello');
    assert.equal(
      stripNoReplySentinel('I would answer NO_REPLY but here is the answer'),
      'I would answer NO_REPLY but here is the answer',
    );
  });

  await t.test('both model return paths are normalised', () => {
    const src = fs.readFileSync('src/openclaw/tenant-openclaw.mjs', 'utf8');
    const fn = src.slice(src.indexOf('export async function runOpenclawTurn'));
    assert.equal((fn.match(/return stripNoReplySentinel\(reply\)/g) || []).length, 2);
    assert.doesNotMatch(fn, /\n\s+return reply;/);
  });
});
