#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/tenant/cli-home/home}"
mkdir -p /tenant/openclaw /tenant/workspace /tenant/cli-home/claude "$HOME"

RUNTIME_HOME="${OPENCLAW_STATE_DIR:-/tenant/openclaw}"
if [ "${ROCKY_CONTAINER_LOCAL_STATE:-0}" = "1" ]; then
  RUNTIME_HOME="/home/rocky/openclaw-runtime"
  mkdir -p "$RUNTIME_HOME"
  if [ -f /tenant/openclaw/openclaw.json ]; then
    cp -f /tenant/openclaw/openclaw.json "$RUNTIME_HOME/openclaw.json"
  fi
  echo "[entrypoint] WARNING: ROCKY_CONTAINER_LOCAL_STATE=1; OpenClaw sessions will not survive container recreation" >&2
fi

export OPENCLAW_STATE_DIR="$RUNTIME_HOME"
mkdir -p /run/rocky
cp -f "$RUNTIME_HOME/openclaw.json" /run/rocky/openclaw.json
chmod 600 /run/rocky/openclaw.json

export OPENCLAW_CONFIG_PATH="/run/rocky/openclaw.json"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/tenant/workspace}"
export OPENCLAW_HOME="$RUNTIME_HOME"
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/tenant/cli-home/claude}"

if [ -d "$CLAUDE_CONFIG_DIR" ]; then
  if [ ! -e "$HOME/.claude" ] || [ -L "$HOME/.claude" ]; then
    ln -sfn "$CLAUDE_CONFIG_DIR" "$HOME/.claude"
  else
    echo "[entrypoint] WARNING: $HOME/.claude exists and is not a symlink; tenant credentials may be ignored" >&2
  fi

  CLAUDE_STATE_FILE="$CLAUDE_CONFIG_DIR/.claude.json"
  if [ -f "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
    if [ ! -f "$CLAUDE_STATE_FILE" ] || [ ! -s "$CLAUDE_STATE_FILE" ]; then
      cp -f "$HOME/.claude.json" "$CLAUDE_STATE_FILE"
    fi
    rm -f "$HOME/.claude.json"
  fi
  [ -f "$CLAUDE_STATE_FILE" ] || printf '{}\n' > "$CLAUDE_STATE_FILE"
  chmod 600 "$CLAUDE_STATE_FILE" 2>/dev/null || true
  ln -sfn "$CLAUDE_STATE_FILE" "$HOME/.claude.json"

  CLAUDE_CACHE_DIR="$CLAUDE_CONFIG_DIR/cli-cache"
  mkdir -p "$CLAUDE_CACHE_DIR" "$HOME/.cache"
  if [ -d "$HOME/.cache/claude-cli-nodejs" ] && [ ! -L "$HOME/.cache/claude-cli-nodejs" ]; then
    cp -a "$HOME/.cache/claude-cli-nodejs/." "$CLAUDE_CACHE_DIR/" 2>/dev/null || true
    rm -rf "$HOME/.cache/claude-cli-nodejs"
  fi
  ln -sfn "$CLAUDE_CACHE_DIR" "$HOME/.cache/claude-cli-nodejs"
fi

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

# Static env credentials outrank Claude subscription OAuth and suppress refresh.
# Scrub only those legacy keys; preserve unrelated Claude settings.
node --input-type=module -e "
import fs from 'node:fs';
const p = process.env.CLAUDE_CONFIG_DIR + '/settings.json';
try {
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (settings.env && typeof settings.env === 'object') {
    delete settings.env.ANTHROPIC_API_KEY;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    delete settings.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (Object.keys(settings.env).length === 0) delete settings.env;
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }
} catch (e) {
  if (e?.code !== 'ENOENT') throw e;
}
"

if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  node --input-type=module -e "
import fs from 'node:fs';
const p = process.env.OPENCLAW_CONFIG_PATH;
const expectedProjection =
  process.env.ROCKY_MCP_PROJECTION || '/run/rocky-input/composio.json';
try {
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (c.agents?.defaults) c.agents.defaults.workspace = '/tenant/workspace';
  if (c.gateway) {
    c.gateway.bind = 'lan';
    if (process.env.OPENCLAW_GATEWAY_PORT) c.gateway.port = Number(process.env.OPENCLAW_GATEWAY_PORT);
  }
  try {
    const projection = JSON.parse(fs.readFileSync(expectedProjection, 'utf8'));
    c.mcp = c.mcp && typeof c.mcp === 'object' ? c.mcp : {};
    c.mcp.servers = c.mcp.servers && typeof c.mcp.servers === 'object' ? c.mcp.servers : {};
    const servers = projection.servers;
    if (!servers || typeof servers !== 'object') {
      throw new Error('MCP projection ' + expectedProjection + ' has no servers map');
    }
    for (const [name, e] of Object.entries(servers)) {
      if (!e || !e.url) continue;
      c.mcp.servers[name] = {
        transport: 'streamable-http',
        url: e.url,
        ...(e.headers ? { headers: e.headers } : {}),
      };
    }
  } catch (e) {
    // The host sets ROCKY_MCP_PROJECTION only when it actually mounted one. A
    // missing file then means the mount is wrong, not that this tenant has no
    // MCP servers — starting anyway would silently strip every external tool.
    if (e?.code !== 'ENOENT' || process.env.ROCKY_MCP_PROJECTION) {
      throw new Error('MCP projection ' + expectedProjection + ' unreadable: ' + (e && e.message ? e.message : e));
    }
  }
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
} catch (e) {
  // Never start degraded. A container whose config did not get rewritten has
  // host paths, the wrong gateway port, or no MCP servers; it would serve
  // turns that quietly lack every external tool.
  console.error('[entrypoint] config rewrite failed:', e?.message || e);
  process.exit(1);
}
"
fi

cd "$OPENCLAW_WORKSPACE_DIR" 2>/dev/null || cd /tenant

exec openclaw "$@"
