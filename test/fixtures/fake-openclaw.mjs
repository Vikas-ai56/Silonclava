#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH is required');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  if (process.env[key]) throw new Error(`forbidden inherited credential: ${key}`);
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeConfig(config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

if (args[0] !== 'mcp') throw new Error(`Unsupported fake command: ${args.join(' ')}`);
const action = args[1];
const config = await readConfig();
config.mcp ||= {};
config.mcp.servers ||= {};
const name = args[2] && !args[2].startsWith('--') ? args[2] : null;

if (action === 'list') {
  process.stdout.write(`${JSON.stringify(config.mcp.servers)}\n`);
} else if (action === 'show') {
  process.stdout.write(`${JSON.stringify(name ? config.mcp.servers[name] : config.mcp.servers)}\n`);
} else if (action === 'status') {
  process.stdout.write(`${JSON.stringify({ path: configPath, servers: Object.entries(config.mcp.servers).map(([serverName, server]) => ({ name: serverName, enabled: server.enabled !== false, auth: server.auth || null })) })}\n`);
} else if (action === 'set') {
  config.mcp.servers[name] = JSON.parse(args[3]);
  await writeConfig(config);
  process.stdout.write(`Saved MCP server "${name}".\n`);
} else if (action === 'add') {
  config.mcp.servers[name] = {
    url: flag('--url'),
    transport: flag('--transport') || 'streamable-http',
    ...(flag('--auth') ? { auth: flag('--auth') } : {}),
    ...(args.includes('--disabled') ? { enabled: false } : {}),
  };
  await writeConfig(config);
  process.stdout.write(`Saved MCP server "${name}".\n`);
} else if (action === 'configure') {
  if (!config.mcp.servers[name]) throw new Error(`No MCP server named "${name}"`);
  if (args.includes('--enable')) delete config.mcp.servers[name].enabled;
  if (args.includes('--disable')) config.mcp.servers[name].enabled = false;
  await writeConfig(config);
  process.stdout.write(`Updated MCP server "${name}".\n`);
} else if (action === 'tools') {
  if (!config.mcp.servers[name]) throw new Error(`No MCP server named "${name}"`);
  if (args.includes('--clear')) delete config.mcp.servers[name].toolFilter;
  else config.mcp.servers[name].toolFilter = {
    ...(flag('--include') ? { include: flag('--include').split(',') } : {}),
    ...(flag('--exclude') ? { exclude: flag('--exclude').split(',') } : {}),
  };
  await writeConfig(config);
  process.stdout.write(`Updated MCP tool selection for "${name}".\n`);
} else if (action === 'unset') {
  delete config.mcp.servers[name];
  await writeConfig(config);
  process.stdout.write(`Removed MCP server "${name}".\n`);
} else if (action === 'login') {
  process.stdout.write(`Open this URL to authorize "${name}":\nhttps://auth.example.test/authorize?state=fake-state\n`);
} else if (action === 'logout') {
  process.stdout.write(`MCP OAuth credentials cleared for "${name}".\n`);
} else if (action === 'probe') {
  process.stdout.write(`${JSON.stringify({ servers: { [name]: { tools: 1, resources: false, prompts: false } }, diagnostics: [] })}\n`);
} else if (action === 'doctor') {
  process.stdout.write(`${JSON.stringify({ path: configPath, ok: true, servers: name ? [{ name, ok: true, issues: [] }] : [] })}\n`);
} else if (action === 'reload') {
  process.stdout.write('Reloaded MCP runtimes.\n');
} else {
  throw new Error(`Unsupported fake MCP action: ${action}`);
}
