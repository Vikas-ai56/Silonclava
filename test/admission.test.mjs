import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  admit, chooseVictim, overdueScore,
  MIN_RESIDENCY_MS, MIN_IDLE_MS, MIN_TYPICAL_GAP_MS,
} from '../src/openclaw/admission.mjs';

const NOW = 10_000_000;
const OLD = NOW - 10 * 60_000;

function entry(tenantId, { idle = 5 * 60_000, gap = MIN_TYPICAL_GAP_MS, inFlight = 0, startedAt = OLD, cron = false } = {}) {
  return { tenantId, inFlight, startedAt, lastUserRequestAt: NOW - idle, typicalGapMs: gap, cron };
}

describe('overdue score', () => {
  it('measures idleness against the tenant\'s own rhythm', () => {
    assert.equal(overdueScore({ idleMs: 240_000, typicalGapMs: 120_000 }), 2);
    assert.equal(overdueScore({ idleMs: 60_000, typicalGapMs: 120_000 }), 0.5);
  });

  it('floors the rhythm so a chatty tenant is not evicted instantly', () => {
    // p75 of 1s would make everyone permanently overdue.
    assert.equal(overdueScore({ idleMs: MIN_TYPICAL_GAP_MS, typicalGapMs: 1000 }), 1);
  });
});

describe('invariants', () => {
  it('never evicts work in flight', () => {
    assert.equal(chooseVictim([entry('busy', { inFlight: 1, idle: 60 * 60_000 })], { now: NOW }), null);
  });

  it('never evicts a container younger than the residency floor', () => {
    const young = entry('young', { startedAt: NOW - (MIN_RESIDENCY_MS - 1), idle: 60 * 60_000 });
    assert.equal(chooseVictim([young], { now: NOW }), null);
  });

  it('never evicts one that has just been used', () => {
    assert.equal(chooseVictim([entry('fresh', { idle: MIN_IDLE_MS - 1 })], { now: NOW }), null);
  });

  it('prefers a cron container, whatever its score', () => {
    const v = chooseVictim([
      entry('person', { idle: 60 * 60_000, gap: 120_000 }),
      entry('job', { idle: 2 * 60_000, gap: 30 * 60_000, cron: true }),
    ], { now: NOW });
    assert.equal(v.tenantId, 'job');
    assert.equal(v.cron, true);
  });

  it('among people, takes the most overdue relative to their own rhythm', () => {
    // 'slow' has been idle longer in absolute terms but returns hourly anyway.
    const v = chooseVictim([
      entry('slow', { idle: 30 * 60_000, gap: 60 * 60_000 }),
      entry('chatty', { idle: 10 * 60_000, gap: 2 * 60_000 }),
    ], { now: NOW });
    assert.equal(v.tenantId, 'chatty', 'absolute idleness is not the signal');
  });
});

describe('admission phases', () => {
  const deps = (entries, opts = {}) => {
    const warm = new Set(entries.map((e) => e.tenantId));
    const stopped = [];
    return {
      stopped, warm,
      d: {
        hasWarm: (id) => warm.has(id),
        warmCount: () => warm.size,
        maxWarm: () => opts.maxWarm ?? entries.length,
        listEntries: () => entries.filter((e) => warm.has(e.tenantId)),
        stop: async (id) => { warm.delete(id); stopped.push(id); },
        now: () => NOW,
        wait: async () => {},
        waitMs: opts.waitMs ?? 0,
        log: { log() {} },
      },
    };
  };

  it('admits straight away when a slot is free', async () => {
    const { d, stopped } = deps([entry('a')], { maxWarm: 3 });
    const r = await admit('newcomer', d);
    assert.deepEqual([r.admitted, r.reason], [true, 'free-slot']);
    assert.deepEqual(stopped, []);
  });

  it('is a no-op for a tenant already warm', async () => {
    const { d } = deps([entry('a')], { maxWarm: 1 });
    assert.equal((await admit('a', d)).reason, 'already-warm');
  });

  it('phase 1: evicts an overdue container', async () => {
    const { d, stopped } = deps([entry('overdue', { idle: 30 * 60_000, gap: 120_000 })], { maxWarm: 1 });
    const r = await admit('newcomer', d);
    assert.equal(r.reason, 'evicted-overdue');
    assert.deepEqual(stopped, ['overdue']);
  });

  it('phase 3: takes the least-bad slot rather than refusing a real user', async () => {
    const notOverdue = entry('patient', { idle: 2 * 60_000, gap: 60 * 60_000 });
    const { d, stopped } = deps([notOverdue], { maxWarm: 1 });
    const r = await admit('newcomer', d);
    assert.equal(r.reason, 'evicted-least-bad');
    assert.deepEqual(stopped, ['patient']);
  });

  it('phase 4: refuses only when every slot is busy or too young', async () => {
    const { d, stopped } = deps([
      entry('working', { inFlight: 1 }),
      entry('starting', { startedAt: NOW - 1000 }),
    ], { maxWarm: 2 });
    const r = await admit('newcomer', d);
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'all-busy-or-too-young');
    assert.deepEqual(stopped, [], 'nothing was harmed on the way to refusing');
  });

  it('phase 2: a slot freed while waiting is used instead of evicting', async () => {
    const busy = entry('working', { inFlight: 1 });
    const { d, warm, stopped } = deps([busy], { maxWarm: 1, waitMs: 3000 });
    d.wait = async () => { warm.delete('working'); };  // the turn finishes
    const r = await admit('newcomer', d);
    assert.equal(r.reason, 'waited-for-slot');
    assert.deepEqual(stopped, [], 'waiting beats evicting');
  });
});
