import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeDisconnect,
  appendOpsAlert,
  postLogoutWebhook,
} from '../src/ops-alert.mjs';
import { OPERATOR_PHONES } from '../src/config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';

describe('ops-alert', () => {
  it('summarizeDisconnect extracts boom conflict type', () => {
    const detail = summarizeDisconnect(
      {
        isBoom: true,
        message: 'Stream Errored',
        output: { statusCode: 515, payload: { statusCode: 515 } },
        data: { tag: 'stream:error', attrs: { code: '515' } },
      },
      515,
    );
    assert.equal(detail.statusCode, 515);
    assert.match(detail.message, /Stream/);
  });

  it('appendOpsAlert writes jsonl row', async () => {
    const log = path.join(ROOT, 'ops', 'alerts.jsonl');
    const before = await fs.readFile(log, 'utf8').catch(() => '');
    const row = await appendOpsAlert('test_event', { foo: 'bar' });
    assert.equal(row.type, 'test_event');
    const after = await fs.readFile(log, 'utf8');
    assert.ok(after.length >= before.length);
    assert.match(after, /test_event/);
  });

  it('postLogoutWebhook returns false when URL unset', async () => {
    assert.equal(await postLogoutWebhook({ statusCode: 401, message: 'logged out' }), false);
  });

});
