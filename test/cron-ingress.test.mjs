import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  verifyCronToken, handleCronDelivery, cronResultText, cronRunIdentity,
} from '../src/cron-ingress.mjs';
import { openTenantStore, decryptBody } from '../src/tenant-data/store.mjs';
import { TURN_STATE } from '../src/tenant-data/migrations.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';
import { resetWakeScheduler } from '../src/wake-scheduler.mjs';

const created = [];
const TOKEN = 'cron-ingress-test-token';

beforeEach(() => {
  resetWakeScheduler();
  process.env.ROCKY_CRON_WEBHOOK_TOKEN = TOKEN;
});

after(async () => {
  delete process.env.ROCKY_CRON_WEBHOOK_TOKEN;
  resetWakeScheduler();
  for (const id of created) {
    await deleteTenant(id).catch(() => {});
    fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  }
});

let seq = 0;
async function tenant(tag) {
  // Numeric and unique: a non-numeric suffix is stripped by phone normalization,
  // which would silently collapse every fixture onto one tenant.
  seq += 1;
  const phone = `1555${String(process.pid).slice(-5)}${seq}`;
  const t = await provisionTenant({
    phone, jid: `${phone}@s.whatsapp.net`, name: `Cron ${tag}`,
    plan: 'claude', email: null, finalState: 'READY',
  });
  created.push(t.id);
  return t;
}

function recorder() {
  const sent = [];
  return {
    sent,
    sendText: async (to, text) => {
      sent.push({ to, text });
      return { ok: true, providerMessageId: `SM_${sent.length}`, status: 'delivered' };
    },
  };
}

describe('cron ingress authentication', () => {
  it('rejects a missing, wrong, or truncated token', () => {
    assert.equal(verifyCronToken(undefined), false);
    assert.equal(verifyCronToken(''), false);
    assert.equal(verifyCronToken('Bearer wrong-token-entirely'), false);
    assert.equal(verifyCronToken(`Bearer ${TOKEN.slice(0, -1)}`), false, 'prefix must not pass');
    assert.equal(verifyCronToken(`Bearer ${TOKEN}x`), false, 'extension must not pass');
  });

  it('accepts the configured token with or without the Bearer prefix', () => {
    assert.equal(verifyCronToken(`Bearer ${TOKEN}`), true);
    assert.equal(verifyCronToken(TOKEN), true);
  });

  it('denies everything when no token is configured', () => {
    const saved = process.env.ROCKY_CRON_WEBHOOK_TOKEN;
    delete process.env.ROCKY_CRON_WEBHOOK_TOKEN;
    try {
      // Fail closed: an unset token must not mean "allow all".
      assert.equal(verifyCronToken('Bearer anything'), false);
      assert.equal(verifyCronToken(''), false);
    } finally {
      process.env.ROCKY_CRON_WEBHOOK_TOKEN = saved;
    }
  });
});

describe('cron delivery handler', () => {
  it('persists then sends, and the delivered bytes equal the stored bytes', async () => {
    const t = await tenant('persist');
    const channel = recorder();
    const out = await handleCronDelivery(
      { jobId: 'j1', runId: 'run-1', summary: 'your 9am digest' }, channel, t.id,
    );
    assert.equal(out.ok, true);
    assert.equal(out.body.delivered, true);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].text, 'your 9am digest');

    const store = openTenantStore(t.id);
    try {
      const msg = store.db.prepare("SELECT direction, body_cipher FROM messages WHERE direction='outbound'").get();
      assert.equal(decryptBody(t.id, msg.body_cipher), channel.sent[0].text);
      const turn = store.db.prepare('SELECT state, route FROM turns').get();
      assert.equal(turn.route, 'cron');
      assert.equal(turn.state, TURN_STATE.COMPLETED);
    } finally { store.db.close(); }
  });

  it('is idempotent: a webhook retry does not send twice', async () => {
    const t = await tenant('idem');
    const channel = recorder();
    const payload = { jobId: 'j1', runId: 'run-dup', summary: 'digest' };
    const first = await handleCronDelivery(payload, channel, t.id);
    const second = await handleCronDelivery(payload, channel, t.id);
    assert.equal(first.body.delivered, true);
    assert.equal(second.body.delivered, false);
    assert.equal(second.body.reason, 'duplicate');
    assert.equal(channel.sent.length, 1, 'a retry must not re-send to the user');
  });

  it('refuses an unknown tenant rather than inventing one', async () => {
    const channel = recorder();
    const out = await handleCronDelivery(
      { jobId: 'j1', runId: 'r', summary: 'hi' }, channel, 'br_does_not_exist',
    );
    assert.equal(out.ok, false);
    assert.equal(out.status, 404);
    assert.equal(channel.sent.length, 0);
  });

  it('rejects a delivery that names no tenant or no run', async () => {
    const channel = recorder();
    const cases = [
      [{ jobId: 'j', runId: 'r', summary: 'x' }, null],
      [{ jobId: 'j', runId: 'r', summary: 'x' }, ''],
      [{ summary: 'x' }, 'br_x'],
      [{}, 'br_x'],
    ];
    for (const [bad, who] of cases) {
      const out = await handleCronDelivery(bad, channel, who);
      assert.equal(out.ok, false);
      assert.equal(out.status, 400);
    }
    assert.equal(channel.sent.length, 0);
  });

  it('treats an empty result as nothing to deliver, not an error', async () => {
    const t = await tenant('empty');
    const channel = recorder();
    const out = await handleCronDelivery({ jobId: 'j1', runId: 'r', summary: '   ' }, channel, t.id);
    assert.equal(out.ok, true);
    assert.equal(out.status, 204);
    assert.equal(channel.sent.length, 0, 'an empty WhatsApp message would fail at the provider');
  });

  it('never lets a model-supplied recipient override the tenant address', async () => {
    const t = await tenant('recipient');
    const channel = recorder();
    await handleCronDelivery(
      // A compromised or confused container tries to redirect delivery.
      { jobId: 'j1', runId: 'r', summary: 'digest', to: '+6599999999', recipient: '+6588888888',
        tenantId: 'br_some_other_tenant' },
      channel,
      t.id,
    );
    assert.equal(channel.sent.length, 1);
    assert.equal(
      channel.sent[0].to,
      t.jid || t.phone,
      'delivery must use the address resolved from tenant state',
    );
  });

  it('applies the privacy guard and sends nothing when it trips', async () => {
    const t = await tenant('policy');
    const channel = recorder();
    await assert.rejects(
      () => handleCronDelivery(
        { jobId: 'j1', runId: 'r', summary: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv' },
        channel,
        t.id,
      ),
      /persistence policy/i,
    );
    assert.equal(channel.sent.length, 0);
  });

  it('records delivery_unknown when the send throws', async () => {
    const t = await tenant('unknown');
    const channel = { sendText: async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); } };
    const out = await handleCronDelivery({ jobId: 'j1', runId: 'r', summary: 'digest' }, channel, t.id);
    assert.equal(out.ok, false);
    assert.equal(out.body.error, 'delivery_unknown');

    const store = openTenantStore(t.id);
    try {
      const turn = store.db.prepare('SELECT state FROM turns').get();
      assert.equal(turn.state, TURN_STATE.DELIVERY_UNKNOWN);
    } finally { store.db.close(); }
  });
});

describe('the payload OpenClaw actually posts', () => {
  it('reads the summary and run identity that the pinned image sends', () => {
    const evt = {
      jobId: '3b5411da-0f21-4ab6-a8b7-0c5ab7043e1f',
      runId: 'run-77',
      status: 'ok',
      summary: 'cron delivery works',
      runAtMs: 1790337600000,
      durationMs: 41_000,
    };
    assert.equal(cronResultText(evt), 'cron delivery works',
      'OpenClaw names the result `summary`, never `text`');
    assert.equal(cronRunIdentity(evt), '3b5411da-0f21-4ab6-a8b7-0c5ab7043e1f:run-77',
      'dedupe needs job and run together — a job id alone repeats every run');
  });

  it('still identifies a run when only runAtMs is present', () => {
    assert.equal(cronRunIdentity({ jobId: 'j', runAtMs: 1700 }), 'j:1700');
  });

  it('identifies nothing when the payload names no run', () => {
    assert.equal(cronRunIdentity({ summary: 'orphan' }), '',
      'a delivery we cannot dedupe must be refused, not guessed at');
  });

  it('two runs of one job are distinct, so neither is swallowed as a duplicate', () => {
    const a = cronRunIdentity({ jobId: 'daily', runId: 'r1' });
    const b = cronRunIdentity({ jobId: 'daily', runId: 'r2' });
    assert.notEqual(a, b, 'a recurring job delivers every day, not once');
  });
});
