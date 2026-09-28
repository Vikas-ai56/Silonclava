import { CRON_WEBHOOK_URL, cronWebhookUrlFor } from '../../config.mjs';
import { createCronJob, removeCronJob } from '../../openclaw/docker-gateway.mjs';
import { tenantOpenclawStateDir } from '../../openclaw/tenant-openclaw.mjs';
import { refreshScheduleMirror, scheduledJobs } from '../../tenant-data/cron-store.mjs';
import { openTenantStore } from '../../tenant-data/store.mjs';
import { startTenantGatewayById } from '../../openclaw/tenant-gateway.mjs';
import { loadTenant } from '../../tenants.mjs';

async function tenantFor(request) {
  const tenantId = String(request.target?.tenantId || '');
  if (!tenantId) throw new Error(`--tenant is required for cron ${request.action}`);
  const tenant = await loadTenant(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

function withStore(tenantId, fn) {
  const store = openTenantStore(tenantId);
  try {
    return fn(store);
  } finally {
    try {
      store.db.close();
    } catch {
      /* already closed */
    }
  }
}

function mirroredJobs(tenantId) {
  return withStore(tenantId, (store) => {
    refreshScheduleMirror(store, tenantOpenclawStateDir(tenantId));
    return scheduledJobs(store);
  });
}

export async function handleResourceAction(request) {
  const tenant = await tenantFor(request);
  const params = request.params || {};

  if (request.action === 'list') {
    return {
      tenantId: tenant.id,
      mutating: false,
      result: { jobs: mirroredJobs(tenant.id), webhook: CRON_WEBHOOK_URL },
    };
  }

  if (request.action === 'create') {
    await startTenantGatewayById(tenant.id);
    const spec = {
      name: params.name,
      message: params.message,
      cron: params.cron,
      every: params.every,
      at: params.at,
      tz: params.tz || tenant.timezone || null,
    };
    const created = await createCronJob(tenant.id, spec, cronWebhookUrlFor(tenant.id));
    return {
      tenantId: tenant.id,
      mutating: true,
      auditParams: { name: spec.name, cron: spec.cron, every: spec.every, at: spec.at },
      auditResult: { jobId: created.jobId },
      result: { ...created, jobs: mirroredJobs(tenant.id) },
    };
  }

  if (request.action === 'remove') {
    const jobId = String(params.job || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new Error('A valid --job id is required');
    await startTenantGatewayById(tenant.id);
    await removeCronJob(tenant.id, jobId);
    return {
      tenantId: tenant.id,
      mutating: true,
      auditParams: { jobId },
      result: { removed: jobId, jobs: mirroredJobs(tenant.id) },
    };
  }

  throw new Error(`Unsupported cron action: ${request.action || '<empty>'}`);
}
