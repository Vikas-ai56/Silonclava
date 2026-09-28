import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_RESET_IDLE_MINUTES } from '../src/config.mjs';
import { buildDockerRunArgs } from '../src/openclaw/docker-gateway.mjs';
import { ensureTenantOpenclaw } from '../src/openclaw/tenant-openclaw.mjs';
import { generateTenantId } from '../src/phone.mjs';
import { provisionTenant } from '../src/provision.mjs';
import { deleteTenant } from '../src/tenants.mjs';

describe('OpenClaw state configuration contract', () => {
  it('binds state durably and preserves multi-day context with a long idle reset', async () => {
    const id = generateTenantId();
    const phone = `1574${String(Date.now()).slice(-8)}`;
    const tenant = await provisionTenant({ id, phone, jid: `${phone}@s.whatsapp.net`, name: 'State Test', plan: 'claude' });
    try {
      const { config } = await ensureTenantOpenclaw(tenant);
      assert.deepEqual(config.session.reset, { mode: 'idle', idleMinutes: SESSION_RESET_IDLE_MINUTES });
      const args = buildDockerRunArgs({ tenantId: id, port: 18791, token: 'gateway-token' });
      assert.ok(args.includes('OPENCLAW_STATE_DIR=/tenant/openclaw'));
      assert.ok(args.some((arg) => arg.endsWith(':/tenant/openclaw:rw')));
      assert.equal(args.includes('OPENCLAW_RUNTIME_HOME=/home/rocky/openclaw-runtime'), false);
    } finally {
      await deleteTenant(id);
    }
  });
});
