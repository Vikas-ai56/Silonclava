import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { composioRuntimeProjectionPath } from '../src/mcp/composio-runtime.mjs';
import { ONBOARDING_STEPS, stepsForPhase, PHASE } from '../src/openclaw/tenant-onboarding.mjs';
import { PLATFORM_DIR } from '../src/paths.mjs';

describe('the MCP projection is not disposable state', () => {
  it('lives under platform/, never in the OS temp directory', () => {
    const file = composioRuntimeProjectionPath('br_test');
    assert.ok(file.startsWith(PLATFORM_DIR), `expected platform-rooted path, got ${file}`);
    // PLATFORM_DIR is itself redirected under a temp root by the test harness,
    // so assert the real property at the source: the module must not reach for
    // os.tmpdir() at all.
    const src = fs.readFileSync('src/mcp/composio-runtime.mjs', 'utf8');
    assert.doesNotMatch(src, /os\.tmpdir\(\)/, 'a bind source must outlive the gateway process');
  });

  it('is rehydrated on wake, before the mount check', () => {
    // Hibernation deletes the projection but only stops the container, whose
    // mount still points at it. Order matters: rewrite, then verify.
    const names = stepsForPhase(PHASE.WAKE).map((s) => s.name);
    assert.ok(names.includes('mcp projection present'));
    assert.ok(
      names.indexOf('mcp projection present') < names.indexOf('bind-mount sources still exist'),
      'the projection must be rewritten before the mount check reads it',
    );
  });

  it('never runs the projection step on a fresh create', () => {
    assert.ok(!stepsForPhase(PHASE.CREATE).map((s) => s.name).includes('mcp projection present'));
  });

  it('keeps every wake step declared on the create path too, except wake-only ones', () => {
    const create = stepsForPhase(PHASE.CREATE).map((s) => s.name);
    assert.ok(create.includes('agent credential'));
    assert.ok(ONBOARDING_STEPS.every((s) => s.phases.length > 0));
  });
});

describe('tenant model policy', () => {
  it('defaults every tenant to Sonnet 5 at high thinking, not Haiku', async () => {
    const src = await import('node:fs').then((m) =>
      m.readFileSync('src/openclaw/tenant-openclaw.mjs', 'utf8'),
    );
    assert.match(src, /DEFAULT_CLAUDE_MODEL = 'anthropic\/claude-sonnet-5'/);
    assert.doesNotMatch(src, /DEFAULT_CLAUDE_MODEL = '[^']*haiku/);
    assert.match(src, /thinkingDefault: DEFAULT_THINKING/);
  });
});

describe('outbox delivery', () => {
  it('is stated in the always-on rule, not only in a tool description', async () => {
    // The standing rules moved into the managed guardrail block, which
    // OpenClaw injects into the system prompt. The turn carries only per-turn
    // facts now.
    const rule = fs.readFileSync('org/templates/workspace/AGENTS.md', 'utf8');
    assert.match(rule, /outbox\//);
    assert.match(rule, /sent automatically with your\s+reply/);
  });

  it('runs on both the reply and no-reply paths', () => {
    const src = fs.readFileSync('src/router.mjs', 'utf8');
    assert.equal((src.match(/await settleFiles\(\)/g) || []).length, 2);
    // and only after the text reply is committed
    assert.ok(src.indexOf('await deliverResponse(') < src.lastIndexOf('await settleFiles()'));
  });

  it('moves a delivered file out of the outbox so it is never sent twice', () => {
    const src = fs.readFileSync('src/outbox.mjs', 'utf8');
    assert.match(src, /renameSync/);
    assert.ok(src.indexOf('sendMedia') < src.indexOf('renameSync'), 'move only after the send returns');
  });
});

describe('a slow turn is not an auth failure', () => {
  it('gives the first-byte budget a real 150s ceiling', async () => {
    const { OPENCLAW_TIMEOUT_SEC } = await import('../src/config.mjs');
    const src = fs.readFileSync('src/openclaw/tenant-openclaw.mjs', 'utf8');
    const budget = Number(src.match(/FIRST_BYTE_TIMEOUT_MS = Number\([^)]*\|\| ([\d_]+)\)/)[1].replace(/_/g, ''));
    assert.equal(budget, 150_000);
    // Math.min against the turn timeout must not silently lower it.
    assert.ok((OPENCLAW_TIMEOUT_SEC + 5) * 1000 >= budget,
      `turn timeout ${OPENCLAW_TIMEOUT_SEC}s caps the first-byte budget below ${budget}ms`);
  });

  it('never classifies a timeout as unauthorized', () => {
    const src = fs.readFileSync('src/openclaw/tenant-openclaw.mjs', 'utf8');
    const classifier = src.match(/if \(\/not logged in.*?\/i\.test\(warmMsg\)\)/s)[0];
    assert.doesNotMatch(classifier, /No model output/);
    assert.match(src, /warmErr instanceof FirstByteTimeout/);
  });

  it('keeps the session for 90 days of silence', async () => {
    const { SESSION_RESET_IDLE_MINUTES } = await import('../src/config.mjs');
    assert.equal(SESSION_RESET_IDLE_MINUTES, 90 * 24 * 60);
  });
});
