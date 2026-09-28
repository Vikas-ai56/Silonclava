import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROCKY_INSTANCE_ID, OPENCLAW_DOCKER_IMAGE } from '../config.mjs';
import { ORG_DIR } from '../paths.mjs';
import { tenantDir } from '../tenants.mjs';
import { composioRuntimeProjectionPath } from '../mcp/composio-runtime.mjs';
import {
  CONTAINER_WORKSPACE,
  CONTAINER_STATE_DIR,
  CONTAINER_CLAUDE_HOME,
  CONTAINER_ORG_DIR,
  CONTAINER_HOME,
  CONTAINER_RUNTIME_DIR,
  CONTAINER_CONFIG_PATH,
  CONTAINER_MCP_PROJECTION,
  CONTAINER_MCP_INPUT_DIR,
} from './container-paths.mjs';

const execFileAsync = promisify(execFile);

// Re-exported from config so there is exactly one pinned image in the tree.
export const DEFAULT_OPENCLAW_IMAGE = OPENCLAW_DOCKER_IMAGE;

export const DOCKER_MEMORY = process.env.ROCKY_OPENCLAW_DOCKER_MEMORY || '2g';
export const DOCKER_CPUS = process.env.ROCKY_OPENCLAW_DOCKER_CPUS || '1';
/** Bound on processes/threads, so a runaway or a fork bomb cannot exhaust the
 *  host's PID space and take down every other tenant. */
export const DOCKER_PIDS_LIMIT = process.env.ROCKY_OPENCLAW_DOCKER_PIDS || '512';

export const RUNTIME_TMPFS = `${CONTAINER_RUNTIME_DIR}:rw,noexec,nosuid,nodev,size=1048576,mode=1777`;

/** Stable container name for a tenant (instance + id — dev/prod never collide). */
/** Shared prefix for every container this instance owns. */
export function rockyContainerPrefix(instanceId = ROCKY_INSTANCE_ID) {
  const inst = String(instanceId || 'local')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 32) || 'local';
  return `rocky-oc-${inst}-`;
}

export function dockerContainerName(tenantId, instanceId = ROCKY_INSTANCE_ID) {
  const inst = String(instanceId || 'local')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 32) || 'local';
  const safe = String(tenantId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '');
  return `rocky-oc-${inst}-${safe}`;
}

export function toDockerBindPath(hostPath) {
  const resolved = path.resolve(hostPath);
  if (process.platform === 'win32') {
    return resolved
      .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, '/');
  }
  return resolved;
}

export function gatewayMetaPath(tenantId) {
  return path.join(tenantDir(tenantId), 'openclaw', '.rocky-gw.json');
}

export async function readGatewayMeta(tenantId) {
  try {
    return JSON.parse(await fsPromises.readFile(gatewayMetaPath(tenantId), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeGatewayMeta(tenantId, meta) {
  const p = gatewayMetaPath(tenantId);
  await fsPromises.mkdir(path.dirname(p), { recursive: true });
  await fsPromises.writeFile(p, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

async function docker(args, { timeoutMs = 120_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err) {
    const stdout = String(err?.stdout || '');
    const stderr = String(err?.stderr || err?.message || err);
    return { ok: false, stdout, stderr, code: err?.code };
  }
}

/** @returns {'running'|'exited'|'missing'|'unknown'} */
export async function dockerContainerState(name) {
  const r = await docker([
    'inspect',
    '-f',
    '{{.State.Status}}',
    name,
  ]);
  if (!r.ok) return 'missing';
  const status = r.stdout.trim().toLowerCase();
  if (status === 'running') return 'running';
  if (status === 'exited' || status === 'created' || status === 'dead') return 'exited';
  return status || 'unknown';
}

export async function dockerStopContainer(name) {
  await docker(['stop', '-t', '10', name], { timeoutMs: 60_000 });
}

export async function dockerRemoveContainer(name) {
  await docker(['rm', '-f', name], { timeoutMs: 60_000 });
}

/**
 * Whether a container was created from the image and mount layout we would use
 * now. A rebuilt image or a changed mount destination does not restart an
 * existing container, so without this a deploy rolls out to new tenants only
 */
export async function containerMatchesCurrentSpec(name, tenantId = tenantIdFromContainerName(name)) {
  const r = await docker([
    'inspect',
    '-f',
    '{{.Config.Image}}{{range .Mounts}}\n{{.Destination}}{{end}}',
    name,
  ]);
  if (!r.ok) return { matches: false, reason: 'container not inspectable' };
  const [image, ...destinations] = r.stdout.trim().split('\n').map((v) => v.trim());
  if (image !== DEFAULT_OPENCLAW_IMAGE) {
    return { matches: false, reason: `image ${image} != ${DEFAULT_OPENCLAW_IMAGE}` };
  }
  const expected = tenantMountSpec(tenantId).map((m) => m.destination);
  const actual = new Set(destinations);
  const missing = expected.filter((d) => !actual.has(d));
  if (missing.length) return { matches: false, reason: `mount destinations changed: ${missing.join(', ')}` };
  return { matches: true };
}

export async function containerMountsIntact(name, tenantId = tenantIdFromContainerName(name)) {
  const r = await docker(['inspect', '-f', '{{range .Mounts}}{{.Source}}\n{{end}}', name]);
  if (!r.ok) return { intact: false, missing: ['<container not found>'] };
  const expected = new Map(tenantMountSpec(tenantId).map((m) => [m.source, m.kind]));
  // The spec omits the projection when the file is absent, which would leave
  // `kind` undefined for exactly the source most likely to be wrong. Its path
  // is deterministic, so assert it whether or not the spec listed it.
  expected.set(composioRuntimeProjectionPath(tenantId), 'file');
  const missing = [];
  for (const source of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let stat = null;
    try {
      stat = fs.statSync(source);
    } catch {
      missing.push(source);
      continue;
    }
    const kind = expected.get(source);
    if (kind === 'file' && !stat.isFile()) missing.push(`${source} (expected a file)`);
    if (kind === 'dir' && !stat.isDirectory()) missing.push(`${source} (expected a directory)`);
  }
  return { intact: missing.length === 0, missing };
}


/**
 * Docker materialises a missing bind source as a root-owned directory rather
 * than failing. For a file mount that wedges the container at exit 127 for
 * good, and the gateway cannot clean up after it: unlink permission lives on
 * the parent, which Docker also created as root. So the check has to happen
 * before Docker is handed control, never after.
 */
export async function dockerStartContainer(name) {
  const { intact, missing } = await containerMountsIntact(name);
  if (!intact) {
    throw new Error(
      `refusing to start ${name}: bind source missing or wrong kind: ${missing.join(', ')}`,
    );
  }
  const r = await docker(['start', name], { timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`docker start ${name} failed: ${r.stderr.slice(0, 400)}`);
}

export async function dockerRunGateway({
  tenantId,
  port,
  token,
  image = DEFAULT_OPENCLAW_IMAGE,
}) {
  const name = dockerContainerName(tenantId);
  const hostTenant = tenantDir(tenantId);
  if (!fs.existsSync(hostTenant)) {
    throw new Error(`Tenant dir missing for docker mount: ${hostTenant}`);
  }
  await fsPromises.mkdir(ORG_DIR, { recursive: true });

  await dockerRemoveContainer(name);

  await ensureMountAccess(tenantId, image);

  const args = buildDockerRunArgs({ tenantId, port, token, image });

  const r = await docker(args, { timeoutMs: 180_000 });
  if (!r.ok) {
    throw new Error(
      `docker run ${name} failed: ${r.stderr.slice(0, 600) || r.stdout.slice(0, 600)}`,
    );
  }

  const existingMeta = (await readGatewayMeta(tenantId)) || {};
  await writeGatewayMeta(tenantId, {
    ...existingMeta,
    runtime: 'docker',
    container: name,
    port,
    token,
    image,
    generation: Number(existingMeta.generation || 0) + 1,
    updatedAt: new Date().toISOString(),
  });

  return { name, port, token, id: r.stdout.trim() };
}

let cachedImageIds = null;

// linux only issue
export async function imageRunAsIds(image = DEFAULT_OPENCLAW_IMAGE) {
  if (cachedImageIds && cachedImageIds.image === image) return cachedImageIds;
  let uid = null;
  let gid = null;

  const inspected = await docker(['image', 'inspect', '--format', '{{.Config.User}}', image]);
  const raw = inspected.ok ? inspected.stdout.trim() : '';
  const [uidPart, gidPart] = raw.split(':');
  if (/^\d+$/.test(uidPart || '')) {
    uid = Number(uidPart);
    gid = /^\d+$/.test(gidPart || '') ? Number(gidPart) : uid;
  } else if (raw) {
    const probe = await docker(['run', '--rm', '--entrypoint', 'id', image, '-u'], { timeoutMs: 60_000 });
    const probeGid = await docker(['run', '--rm', '--entrypoint', 'id', image, '-g'], { timeoutMs: 60_000 });
    if (probe.ok && /^\d+$/.test(probe.stdout.trim())) uid = Number(probe.stdout.trim());
    if (probeGid.ok && /^\d+$/.test(probeGid.stdout.trim())) gid = Number(probeGid.stdout.trim());
  }

  cachedImageIds = { image, uid, gid };
  return cachedImageIds;
}

function grantTree(root, gid) {
  let changed = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      if (st.gid !== gid) fs.chownSync(p, st.uid, gid);
      const want = st.isDirectory() ? 0o2770 : 0o660;
      if ((st.mode & 0o7777) !== want) fs.chmodSync(p, want);
      changed += 1;
    } catch {
      // Not owner, or a path the host user cannot alter — surfaced by the
      // container failing to start, which is louder than a partial chmod here.
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
    }
  };
  walk(root);
  return changed;
}

export async function ensureMountAccess(tenantId, image = DEFAULT_OPENCLAW_IMAGE) {
  const { gid } = await imageRunAsIds(image);
  if (!Number.isInteger(gid)) return { gid: null, touched: 0 };
  const hostTenant = tenantDir(tenantId);
  let touched = 0;
  for (const rel of [['workspace'], ['openclaw'], ['cli-home', 'claude']]) {
    const target = path.join(hostTenant, ...rel);
    if (fs.existsSync(target)) touched += grantTree(target, gid);
  }
  return { gid, touched };
}

//linux only issue
export function hostUidArgs(platform = process.platform) {
  if (platform !== 'linux') return [];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return [];
  return ['--user', `${uid}:${gid}`];
}

export function tenantMountSpec(tenantId) {
  const hostTenant = tenantDir(tenantId);
  const spec = [
    { source: path.join(hostTenant, 'workspace'), destination: CONTAINER_WORKSPACE, kind: 'dir', mode: 'rw' },
    { source: path.join(hostTenant, 'openclaw'), destination: CONTAINER_STATE_DIR, kind: 'dir', mode: 'rw' },
    { source: path.join(hostTenant, 'cli-home', 'claude'), destination: CONTAINER_CLAUDE_HOME, kind: 'dir', mode: 'rw' },
    { source: ORG_DIR, destination: CONTAINER_ORG_DIR, kind: 'dir', mode: 'ro' },
  ];
  const projection = composioRuntimeProjectionPath(tenantId);
  if (fs.existsSync(projection)) {
    spec.push({ source: projection, destination: CONTAINER_MCP_PROJECTION, kind: 'file', mode: 'ro' });
  }
  return spec;
}

/** Pure docker argv builder used by isolation/security tests. */
export function buildDockerRunArgs({
  tenantId,
  port,
  token,
  image = DEFAULT_OPENCLAW_IMAGE,
}) {
  const name = dockerContainerName(tenantId);
  const hostTenant = tenantDir(tenantId);
  const mounts = tenantMountSpec(tenantId).map(
    (m) => `${toDockerBindPath(m.source)}:${m.destination}:${m.mode}`,
  );
  const args = [
    'run',
    '-d',
    '--name',
    name,
    ...hostUidArgs(),
    '--restart',
    'no',
    '--memory',
    DOCKER_MEMORY,
    '--cpus',
    DOCKER_CPUS,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges', // setuid binaries cannot raise privileges mid-run
    '--pids-limit',
    DOCKER_PIDS_LIMIT,
    '--tmpfs',
    RUNTIME_TMPFS,
    '-p',
    `127.0.0.1:${port}:${port}`,
    ...mounts.flatMap((mount) => ['-v', mount]),
    '-e',
    `OPENCLAW_WORKSPACE_DIR=${CONTAINER_WORKSPACE}`,
    '-e',
    `OPENCLAW_STATE_DIR=${CONTAINER_STATE_DIR}`,
    '-e',
    `OPENCLAW_CONFIG_PATH=${CONTAINER_CONFIG_PATH}`,
    '-e',
    `OPENCLAW_HOME=${CONTAINER_STATE_DIR}`,
    '-e',
    `CLAUDE_CONFIG_DIR=${CONTAINER_CLAUDE_HOME}`,
    '-e',
    `OPENCLAW_GATEWAY_PORT=${port}`,
    '-e',
    `OPENCLAW_GATEWAY_TOKEN=${token}`,
    // Never inherit host Claude from the image user home
    '-e',
    `HOME=${CONTAINER_HOME}`,
    ...(process.env.ROCKY_CONTAINER_LOCAL_STATE === '1'
      ? ['-e', 'ROCKY_CONTAINER_LOCAL_STATE=1']
      : []),
    ...(tenantMountSpec(tenantId).some((m) => m.destination === CONTAINER_MCP_PROJECTION)
      ? ['-e', `ROCKY_MCP_PROJECTION=${CONTAINER_MCP_PROJECTION}`]
      : []),
    image,
    'gateway',
    'run',
    '--port',
    String(port),
    '--bind',
    'lan',
    '--auth',
    'token',
    '--token',
    token,
  ];
  return args;
}

const CONTRACT_LABELS = {
  'dev.rocky.contract.runtime-dir': CONTAINER_RUNTIME_DIR,
  'dev.rocky.contract.mcp-input-dir': CONTAINER_MCP_INPUT_DIR,
};

export async function readImageContract(image) {
  const format = Object.keys(CONTRACT_LABELS)
    .map((k) => `{{index .Config.Labels "${k}"}}`)
    .join('\n');
  const r = await docker(['image', 'inspect', '-f', format, image]);
  if (!r.ok) throw new Error(`docker image inspect ${image} failed: ${r.stderr.slice(0, 300)}`);
  const values = r.stdout.split('\n').map((v) => v.trim());
  return Object.fromEntries(Object.keys(CONTRACT_LABELS).map((k, i) => [k, values[i] || null]));
}

export async function assertImageContract(image = DEFAULT_OPENCLAW_IMAGE) {
  const found = await readImageContract(image);
  const wrong = Object.entries(CONTRACT_LABELS)
    .filter(([label, expected]) => found[label] !== expected)
    .map(([label, expected]) => `${label}: image=${found[label] ?? '<absent>'} host=${expected}`);
  if (wrong.length) {
    throw new Error(
      `Image ${image} does not match this host's container contract — ${wrong.join('; ')}. ` +
      'Rebuild the image from the current Dockerfile.openclaw.',
    );
  }
  return true;
}

export async function dockerLogsTail(name, lines = 40) {
  const r = await docker(['logs', '--tail', String(lines), name], { timeoutMs: 30_000 });
  return `${r.stdout}\n${r.stderr}`.trim();
}

export async function listRockyContainers(instanceId = ROCKY_INSTANCE_ID) {
  const prefix = rockyContainerPrefix(instanceId);
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}',
    ]);
    return stdout.split('\n').map((n) => n.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The tenant id encoded in a container name, or null if it is not ours. */
export function tenantIdFromContainerName(name, instanceId = ROCKY_INSTANCE_ID) {
  const prefix = rockyContainerPrefix(instanceId);
  const value = String(name || '');
  return value.startsWith(prefix) ? value.slice(prefix.length) || null : null;
}

export function quarantineForeignPathState(tenantId, { hostRoot = null } = {}) {
  const agentsDir = path.join(tenantDir(tenantId), 'openclaw', 'agents');
  if (!fs.existsSync(agentsDir)) return { quarantined: false, reason: 'no agent state' };

  // Any absolute host path that cannot exist inside the container. The tenant
  // root is the reliable marker: the container sees /tenant, never the host path.
  const marker = hostRoot || path.resolve(tenantDir(tenantId), '..', '..');
  let offending = null;

  const scan = (dir) => {
    if (offending) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (offending) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.(json|jsonl)$/.test(entry.name)) continue;
      try {
        if (fs.readFileSync(full, 'utf8').includes(marker)) offending = full;
      } catch {
        /* unreadable: leave it alone */
      }
    }
  };
  scan(agentsDir);

  if (!offending) return { quarantined: false, reason: 'no host paths found' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const movedTo = path.join(tenantDir(tenantId), 'openclaw', `agents-quarantined-${stamp}`);
  fs.renameSync(agentsDir, movedTo);
  fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  console.warn(
    `[openclaw-gw] tenant ${tenantId}: OpenClaw session state contained host paths ` +
    `(e.g. ${path.relative(tenantDir(tenantId), offending)}); quarantined to ` +
    `${path.basename(movedTo)}. The canonical transcript is unaffected; the model ` +
    'starts a fresh session.',
  );
  return { quarantined: true, movedTo };
}

export function cronAddArgs(spec, webhookUrl) {
  const name = String(spec?.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(name)) {
    throw new Error('A cron job needs a --name of 1-64 safe characters');
  }
  const message = String(spec?.message || '').trim();
  if (!message) throw new Error('A cron job needs a --message for the agent to run');
  if (message.length > 4000) throw new Error('Cron message is too long (max 4000 chars)');

  const schedules = ['cron', 'every', 'at'].filter((k) => spec?.[k]);
  if (schedules.length !== 1) {
    throw new Error('Exactly one of --cron, --every or --at is required');
  }
  const args = ['cron', 'add', '--name', name, '--message', message];
  if (spec.cron) {
    const expr = String(spec.cron).trim();
    if (!/^[-0-9*/,\s]{1,100}$/.test(expr) || expr.split(/\s+/).length < 5) {
      throw new Error(`Not a cron expression: ${expr}`);
    }
    args.push('--cron', expr);
  }
  if (spec.every) {
    const every = String(spec.every).trim();
    if (!/^[0-9]{1,4}[smhd]$/.test(every)) throw new Error(`Not a duration: ${every}`);
    args.push('--every', every);
  }
  if (spec.at) {
    const at = String(spec.at).trim();
    if (!/^[-+0-9A-Za-z:.]{1,40}$/.test(at)) throw new Error(`Not a run-at time: ${at}`);
    args.push('--at', at);
  }
  if (spec.tz) {
    const tz = String(spec.tz).trim();
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) {
      throw new Error(`Not an IANA timezone: ${tz}`);
    }
    args.push('--tz', tz);
  }
  return [...args, '--webhook', webhookUrl, '--session', 'isolated', '--json'];
}

export async function createCronJob(tenantId, spec, webhookUrl) {
  const args = cronAddArgs(spec, webhookUrl);
  const { stdout } = await execFileAsync('docker', [
    'exec', dockerContainerName(tenantId), 'openclaw', ...args,
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`openclaw cron add returned unparseable output: ${stdout.slice(0, 200)}`);
  }
  const jobId = parsed?.id || parsed?.jobId || parsed?.job?.id || null;
  if (!jobId) throw new Error('openclaw cron add reported no job id');
  return { jobId, name: spec.name };
}

export async function removeCronJob(tenantId, jobId) {
  await execFileAsync('docker', [
    'exec', dockerContainerName(tenantId), 'openclaw', 'cron', 'rm', String(jobId),
  ]);
  return { jobId };
}

export async function reconcileCronDelivery(tenantId, webhookUrl, jobIds) {
  const name = dockerContainerName(tenantId);
  const fixed = [];
  for (const jobId of jobIds) {
    try {
      await execFileAsync('docker', [
        'exec', name, 'openclaw', 'cron', 'edit', jobId, '--webhook', webhookUrl,
      ]);
      fixed.push(jobId);
    } catch (err) {
      console.warn(`[cron] could not set webhook on ${jobId}:`, err?.message || err);
    }
  }
  return fixed;
}
