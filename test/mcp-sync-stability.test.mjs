import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeConnectionFingerprint } from '../src/tenant-cli/resources/mcp.mjs';

const active = (toolkit, connectionId) => ({
  toolkit, connectionId, connected: true, status: 'ACTIVE',
});

describe('a sync must not recycle a container that did not need it', () => {
  it('is the same for the same accounts in any order', () => {
    const a = [active('gmail', 'ca_1'), active('asana', 'ca_2')];
    assert.equal(
      activeConnectionFingerprint(a),
      activeConnectionFingerprint([...a].reverse()),
      'Composio returns connections in no guaranteed order; a reorder is not a change',
    );
  });

  it('changes when an account is added or removed', () => {
    const before = [active('gmail', 'ca_1')];
    const added = [...before, active('gmail', 'ca_2')];
    assert.notEqual(activeConnectionFingerprint(before), activeConnectionFingerprint(added),
      'a second mailbox genuinely changes what the endpoint must expose');
    assert.notEqual(activeConnectionFingerprint(added), activeConnectionFingerprint([]),
      'losing every account is a change too');
  });

  it('ignores connections that are not active', () => {
    const withDead = [
      active('gmail', 'ca_1'),
      { toolkit: 'linear', connectionId: 'ca_x', connected: false, status: 'EXPIRED' },
    ];
    assert.equal(activeConnectionFingerprint([active('gmail', 'ca_1')]),
      activeConnectionFingerprint(withDead),
      'an expired connection is not in the endpoint, so it cannot change it');
  });

  it('respects the approved-toolkit filter', () => {
    const conns = [active('gmail', 'ca_1'), active('notapproved', 'ca_2')];
    assert.equal(
      activeConnectionFingerprint(conns, new Set(['gmail'])),
      activeConnectionFingerprint([active('gmail', 'ca_1')], new Set(['gmail'])),
      'a toolkit the org does not approve never reaches the endpoint',
    );
  });
});
