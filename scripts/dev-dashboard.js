#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const children = [
  spawn('node', ['scripts/dashboard-server.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: process.env.API_PORT || '3001' },
  }),
  spawn('npx', ['vite', '--config', 'dashboard/vite.config.js', '--host', '127.0.0.1'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_TARGET: process.env.VITE_API_TARGET || 'http://localhost:3001' },
  }),
];

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
}

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      for (const sibling of children) {
        if (sibling !== child) sibling.kill('SIGTERM');
      }
      process.exit(code);
    }
  });
}
