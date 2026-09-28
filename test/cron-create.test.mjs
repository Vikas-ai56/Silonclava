import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronAddArgs } from '../src/openclaw/docker-gateway.mjs';

const HOOK = 'https://rocky.example/internal/cron/delivery';
const args = (spec) => cronAddArgs(spec, HOOK);
const valueAfter = (list, flag) => list[list.indexOf(flag) + 1];

describe('building an openclaw cron job', () => {
  it('always delivers to Rocky and never to the chat directly', () => {
    const out = args({ name: 'morning', message: 'brief me', cron: '0 9 * * *' });
    assert.equal(valueAfter(out, '--webhook'), HOOK,
      'a job that announces into the container bypasses the delivery ledger');
    assert.ok(out.includes('--json'), 'the job id has to be machine-readable');
    assert.equal(valueAfter(out, '--session'), 'isolated',
      'a scheduled run must not mutate the live chat session');
  });

  it('carries the schedule the caller asked for', () => {
    assert.equal(valueAfter(args({ name: 'a', message: 'm', cron: '30 8 * * 1-5' }), '--cron'),
      '30 8 * * 1-5');
    assert.equal(valueAfter(args({ name: 'a', message: 'm', every: '15m' }), '--every'), '15m');
    assert.equal(valueAfter(args({ name: 'a', message: 'm', at: '+30m' }), '--at'), '+30m');
    assert.equal(valueAfter(args({ name: 'a', message: 'm', cron: '0 9 * * *', tz: 'Asia/Kolkata' }), '--tz'),
      'Asia/Kolkata', 'a 9am reminder is 9am where the user is');
  });

  it('refuses a job with no schedule, or more than one', () => {
    assert.throws(() => args({ name: 'a', message: 'm' }), /Exactly one/);
    assert.throws(() => args({ name: 'a', message: 'm', cron: '0 9 * * *', every: '10m' }),
      /Exactly one/);
  });

  it('refuses a job that would do nothing', () => {
    assert.throws(() => args({ name: 'a', every: '10m' }), /--message/);
    assert.throws(() => args({ name: 'a', message: '   ', every: '10m' }), /--message/);
    assert.throws(() => args({ message: 'm', every: '10m' }), /--name/);
  });

  it('rejects values that are not what they claim to be', () => {
    assert.throws(() => args({ name: 'a', message: 'm', cron: 'every monday' }), /cron expression/);
    assert.throws(() => args({ name: 'a', message: 'm', every: '10' }), /duration/);
    assert.throws(() => args({ name: 'a', message: 'm', every: '10m', tz: 'Mars/Olympus Mons' }),
      /timezone/);
  });

  it('keeps shell metacharacters out of the job name', () => {
    for (const name of ['a; rm -rf /', '$(whoami)', '../../etc/passwd', 'a`id`', 'a|b']) {
      assert.throws(() => args({ name, message: 'm', every: '10m' }), /--name/, name);
    }
  });

  it('passes a message through verbatim, as one argv entry', () => {
    const nasty = 'summarise; echo $HOME && cat /etc/passwd';
    const out = args({ name: 'ok', message: nasty, every: '10m' });
    assert.equal(valueAfter(out, '--message'), nasty,
      'argv means the shell never sees it — the text must not be mangled either');
  });

  it('caps a message that would never fit a turn', () => {
    assert.throws(() => args({ name: 'a', message: 'x'.repeat(4001), every: '10m' }), /too long/);
  });
});
