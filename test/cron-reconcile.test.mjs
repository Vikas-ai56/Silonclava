import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { jobsNeedingWebhook } from '../src/tenant-data/cron-store.mjs';
import { interruptedTurnPreamble } from '../src/tenant-data/context-store.mjs';
import { CRON_WEBHOOK_URL } from '../src/config.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeOpenclawDir(jobs) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'rocky-cronrec-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const db = new Database(path.join(dir, 'state', 'openclaw.sqlite'));
  db.exec(`CREATE TABLE cron_jobs (job_id TEXT, name TEXT, enabled INTEGER,
           delivery_mode TEXT, delivery_to TEXT)`);
  const ins = db.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)');
  for (const j of jobs) ins.run(j.id, j.name, j.enabled ? 1 : 0, j.mode, j.to);
  db.close();
  return dir;
}

describe('cron delivery reconciliation', () => {
  it('flags jobs that announce instead of delivering to Rocky', () => {
    const dir = fakeOpenclawDir([{ id: 'a', name: 'digest', enabled: true, mode: 'announce', to: null }]);
    const pending = jobsNeedingWebhook(dir, CRON_WEBHOOK_URL);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'digest');
    assert.equal(pending[0].mode, 'announce');
  });

  it('leaves correctly configured jobs alone', () => {
    const dir = fakeOpenclawDir([{ id: 'a', name: 'ok', enabled: true, mode: 'webhook', to: CRON_WEBHOOK_URL }]);
    assert.deepEqual(jobsNeedingWebhook(dir, CRON_WEBHOOK_URL), []);
  });

  it('flags a job pointing at the wrong webhook', () => {
    const dir = fakeOpenclawDir([{ id: 'a', name: 'stale', enabled: true, mode: 'webhook', to: 'http://elsewhere/x' }]);
    assert.equal(jobsNeedingWebhook(dir, CRON_WEBHOOK_URL).length, 1);
  });

  it('ignores disabled jobs', () => {
    const dir = fakeOpenclawDir([{ id: 'a', name: 'off', enabled: false, mode: 'announce', to: null }]);
    assert.deepEqual(jobsNeedingWebhook(dir, CRON_WEBHOOK_URL), []);
  });

  it('returns null when the source is unreadable rather than claiming none', () => {
    assert.equal(jobsNeedingWebhook('/tmp/does-not-exist-at-all', CRON_WEBHOOK_URL), null);
  });
});

describe('interrupted-turn verification', () => {
  it('tells the model to verify before repeating, and to ask when unsure', () => {
    const p = interruptedTurnPreamble();
    assert.match(p, /interrupted/i);
    assert.match(p, /check whether the work already exists/i);
    assert.match(p, /do\s+not repeat/i);
    assert.match(p, /ask before acting/i);
  });

  it('is applied only on a retry, never on a first attempt', async () => {
    const src = await fs.promises.readFile('src/router.mjs', 'utf8');
    assert.match(src, /turn\.attempt > 1.*interruptedTurnPreamble/s);
  });
});
