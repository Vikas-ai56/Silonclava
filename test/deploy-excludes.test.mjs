import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * A deploy rsync re-copied the laptop's `platform/vault/` over production's,
 * replacing records encrypted with prod's master key with ones encrypted by a
 * dev key. Every credential read then failed with "Vault key mismatch", and
 * because it happened during an unrelated deploy it looked like a code bug.
 */
describe('deploy excludes', () => {
  const list = fs.readFileSync('deploy/rsync-exclude.txt', 'utf8');
  const entries = list.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  it('never ships environment-owned state', () => {
    for (const required of ['platform/', 'tenants/', '.env.local']) {
      assert.ok(entries.includes(required), `deploy must exclude ${required}`);
    }
  });

  it('the push script uses the exclude file rather than inline flags', () => {
    const push = fs.readFileSync('deploy/push.sh', 'utf8');
    assert.match(push, /--exclude-from/, 'inline --exclude flags drift; use the list');
    assert.doesNotMatch(push, /--exclude\s+['"]?platform/, 'platform must come from the list');
  });
});
