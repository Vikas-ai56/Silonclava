import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

describe('Claude credential plumbing contract', () => {
  it('keeps Claude CLI home bind-mounted and removes static-token precedence', async () => {
    const entrypoint = await fs.readFile('docker/openclaw/entrypoint.sh', 'utf8');
    assert.match(entrypoint, /CLAUDE_CONFIG_DIR="\$\{CLAUDE_CONFIG_DIR:-\/tenant\/cli-home\/claude\}"/);
    assert.doesNotMatch(entrypoint, /CLAUDE_LOCAL/);

    // `$HOME/.claude` may appear, but ONLY as a symlink to the bind-mounted
    // tenant credentials. This rule used to ban the string outright; that
    // blocked the very fix its intent requires. OpenClaw strips
    // CLAUDE_CONFIG_DIR before launching the Claude CLI (it is in
    // CLAUDE_CLI_CLEAR_ENV), so the CLI reads $HOME/.claude — without the link
    // the container has no reachable credentials at all, which is what broke
    // every Docker turn until 2026-09-18.
    const homeClaudeLines = entrypoint
      .split('\n')
      .filter((l) => l.includes('/home/rocky/.claude') || l.includes('$HOME/.claude'))
      .filter((l) => !l.trim().startsWith('#'));
    for (const line of homeClaudeLines) {
      assert.match(
        line,
        /ln -sfn "\$CLAUDE_CONFIG_DIR"|ln -sfn "\$CLAUDE_STATE_FILE"|-L "\$HOME\/\.claude"|-e "\$HOME\/\.claude"|-f "\$HOME\/\.claude\.json"|cp -f "\$HOME\/\.claude\.json" "\$CLAUDE_STATE_FILE"|rm -f "\$HOME\/\.claude\.json"|echo .*WARNING/,
        `\$HOME/.claude must only be linked to the mount, never used directly: ${line.trim()}`,
      );
    }
    // And it must point at the tenant mount, not a container-local directory.
    assert.match(entrypoint, /ln -sfn "\$CLAUDE_CONFIG_DIR" "\$HOME\/\.claude"/);
    assert.doesNotMatch(entrypoint, /\/tenant\/vault\/llm-auth\.json/);

    // `.claude.json` is a FILE beside the `.claude` directory, so the link above
    // does not cover it. It must be persisted into the same mount, and the link
    // target must be derived from CLAUDE_CONFIG_DIR so it cannot point at a
    // container-local path.
    assert.match(entrypoint, /CLAUDE_STATE_FILE="\$CLAUDE_CONFIG_DIR\/\.claude\.json"/);
    assert.match(entrypoint, /ln -sfn "\$CLAUDE_STATE_FILE" "\$HOME\/\.claude\.json"/);
  });
});
