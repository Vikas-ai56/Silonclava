import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTenantClient, executeTenantCommand } from '../src/tenant-cli/index.mjs';

describe('removed provider-specific Google OAuth', () => {
  it('has no Google provider modules, account resource, or client facade', async () => {
    for (const file of [
      'src/tenant-cli/resources/account.mjs',
      'src/tenant-cli/providers/google/index.mjs',
      'src/tenant-cli/providers/google/oauth.mjs',
      'src/tenant-cli/providers/google/credentials.mjs',
      'src/tenant-cli/providers/google/session.mjs',
    ]) {
      await assert.rejects(fs.access(file), { code: 'ENOENT' });
    }
    const client = createTenantClient({ tenantId: '__test_google_removed' });
    assert.equal(client.account, undefined);
    await assert.rejects(
      executeTenantCommand(
        ['account', 'status', '--provider', 'google', '--tenant', '__test_google_removed'],
        { authorization: { kind: 'operator', principal: 'test' } },
      ),
      /unsupported resource/i,
    );
  });
});
