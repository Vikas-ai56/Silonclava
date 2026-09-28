import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { quarantineForeignPathState } from '../src/openclaw/docker-gateway.mjs';
import { tenantDir } from '../src/tenants.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const ids = [];
after(() => {
  for (const id of ids) fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
});
function fresh(tag) {
  const id = `br_dockerfix_${tag}_${process.pid}`;
  ids.push(id);
  fs.rmSync(path.join(TENANTS_DIR, id), { recursive: true, force: true });
  return id;
}

describe('entrypoint links $HOME/.claude to the mounted credentials', () => {
  it('creates the link, because CLAUDE_CONFIG_DIR alone is stripped', async () => {
    const sh = await fs.promises.readFile('docker/openclaw/entrypoint.sh', 'utf8');
    // OpenClaw lists CLAUDE_CONFIG_DIR in CLAUDE_CLI_CLEAR_ENV and strips it
    // before launching the CLI, so the CLI reads $HOME/.claude instead.
    assert.match(sh, /ln -sfn "\$CLAUDE_CONFIG_DIR" "\$HOME\/\.claude"/);
    // It must not clobber a real directory if one exists.
    assert.match(sh, /-L "\$HOME\/\.claude"/);
    assert.match(sh, /WARNING.*not a symlink/);
  });
});

describe('quarantine of spawn-polluted OpenClaw state', () => {
  it('moves aside state containing host paths and leaves a clean dir', () => {
    const id = fresh('polluted');
    const agents = path.join(tenantDir(id), 'openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(agents, { recursive: true });
    // Exactly the shape the spawn runtime writes.
    fs.writeFileSync(
      path.join(agents, 'sessions.json'),
      JSON.stringify({ path: `${path.resolve(TENANTS_DIR, '..')}/tenants/${id}/workspace` }),
    );

    const out = quarantineForeignPathState(id);
    assert.equal(out.quarantined, true, 'host paths must be detected');
    assert.ok(fs.existsSync(out.movedTo), 'quarantined, not deleted — operators can inspect it');
    assert.ok(
      fs.existsSync(path.join(tenantDir(id), 'openclaw', 'agents')),
      'a clean agents dir must remain so OpenClaw can rebuild',
    );
    assert.equal(
      fs.readdirSync(path.join(tenantDir(id), 'openclaw', 'agents')).length,
      0,
    );
  });

  it('leaves container-native state untouched', () => {
    const id = fresh('clean');
    const agents = path.join(tenantDir(id), 'openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(agents, { recursive: true });
    // Paths as the container writes them.
    fs.writeFileSync(
      path.join(agents, 'sessions.json'),
      JSON.stringify({ path: '/tenant/workspace', cwd: '/tenant/workspace' }),
    );

    const out = quarantineForeignPathState(id);
    assert.equal(out.quarantined, false, 'clean state must not be discarded');
    assert.equal(out.reason, 'no host paths found');
    assert.ok(fs.existsSync(path.join(agents, 'sessions.json')));
  });

  it('is a no-op when there is no agent state at all', () => {
    const id = fresh('none');
    fs.mkdirSync(path.join(tenantDir(id), 'openclaw'), { recursive: true });
    const out = quarantineForeignPathState(id);
    assert.equal(out.quarantined, false);
    assert.equal(out.reason, 'no agent state');
  });

  it('never touches the canonical transcript', () => {
    const id = fresh('transcript');
    const dataDir = path.join(tenantDir(id), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tenant.sqlite'), 'canonical');
    const agents = path.join(tenantDir(id), 'openclaw', 'agents', 'main');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 's.json'), `{"p":"${path.resolve(TENANTS_DIR, '..')}/x"}`);

    quarantineForeignPathState(id);
    // §1.5: runtime-native history is disposable; the canonical transcript is not.
    assert.equal(fs.readFileSync(path.join(dataDir, 'tenant.sqlite'), 'utf8'), 'canonical');
  });
});
