#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadLocalEnv } from '../src/load-env.mjs';

loadLocalEnv();

// Compose ships either as a `docker compose` plugin or the standalone
// `docker-compose` binary. Prod has only the standalone one.
const { spawnSync } = await import('node:child_process');
const hasPlugin = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
const [bin, prefix] = hasPlugin ? ['docker', ['compose']] : ['docker-compose', []];

// Keep the existing project name: the live stack and its postgres volume are
// prefixed `rift`, and the volume is what holds the connector database.
const project = process.env.COMPOSE_PROJECT_NAME || 'rift';

const child = spawn(bin, [...prefix, '-p', project, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
