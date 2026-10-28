#!/usr/bin/env node
// Starts every Postboard process with its configuration (this file plays the role of a
// docker-compose.yml). `node start.mjs --fresh` wipes local data and traces first.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const shared = {
  TRACE_DIR: path.join(root, 'telemetry', 'traces'),
  PLACEHOLDER_API: 'https://jsonplaceholder.typicode.com',
  PUBLIC_URL: 'http://localhost:3000',
};

const services = [
  { name: 'event-bus', script: 'services/event-bus/server.mjs', env: { PORT: '4003' } },
  {
    name: 'auth', script: 'services/auth/server.mjs',
    env: { PORT: '4001', POSTS_URL: 'http://localhost:4002', AUTH_SECRET: 'postboard-dev-secret' },
  },
  {
    name: 'posts-api', script: 'services/posts-api/server.mjs',
    env: { PORT: '4002', AUTH_URL: 'http://localhost:4001', BUS_URL: 'http://localhost:4003', DB_PATH: path.join(root, 'data', 'posts.db') },
  },
  {
    name: 'indexer', script: 'services/indexer/worker.mjs',
    env: {
      BUS_URL: 'http://localhost:4003', POSTS_URL: 'http://localhost:4002',
      WEBHOOK_URL: 'https://postman-echo.com/post', EXPORT_DIR: path.join(root, 'data', 'exports'),
    },
  },
  { name: 'gateway', script: 'services/gateway/server.mjs', env: { PORT: '3000', AUTH_URL: 'http://localhost:4001', POSTS_URL: 'http://localhost:4002' } },
];

if (process.argv.includes('--fresh')) {
  fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'telemetry'), { recursive: true, force: true });
  console.log('cleared data/ and telemetry/');
}

const COLORS = [36, 35, 33, 32, 34];
const children = services.map((svc, i) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', svc.script], {
    cwd: root,
    env: { ...process.env, ...shared, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${COLORS[i % COLORS.length]}m${svc.name.padEnd(9)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => { if (!shuttingDown) console.log(`${tag}exited (${code})`); });
  return child;
});

let shuttingDown = false;
const stop = () => {
  shuttingDown = true;
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setTimeout(() => console.log('\nPostboard is up → http://localhost:3000  (Ctrl+C to stop)\n'), 600);
