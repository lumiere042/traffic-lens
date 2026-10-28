#!/usr/bin/env node
// Generates realistic traffic through the gateway so the services emit traces.
//   node scripts/simulate.mjs [rounds=8]
// Requires the stack to be running (npm start).

const BASE = process.env.GATEWAY_URL || 'http://localhost:3000';
const rounds = Number(process.argv[2] || 8);
const USERS = ['Bret', 'Antonette', 'Samantha', 'Karianne', 'Kamren'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const statuses = new Map();

async function call(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const key = `${method} ${path.replace(/\/\d+/g, '/:id').replace(/\?.*$/, '')} → ${res.status}`;
  statuses.set(key, (statuses.get(key) || 0) + 1);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function round(i) {
  const username = pick(USERS);
  if (Math.random() < 0.15) await call('POST', '/auth/login', { body: { username, password: 'wrong' } });
  const { token } = (await call('POST', '/auth/login', { body: { username, password: 'demo' } })) || {};
  await call('GET', '/auth/me', { token });

  const posts = (await call('GET', '/api/posts')) || [];
  const some = pick(posts.length ? posts : [{ id: 1 }]);
  await call('GET', `/api/posts/${some.id}`);
  await call('GET', `/api/posts/${some.id}/comments`);
  if (Math.random() < 0.4) await call('GET', `/api/posts/search?q=${pick(['qui', 'dolor', 'sunt', 'est'])}`);

  // the frontend pins without sending its token
  await call('PATCH', `/api/posts/${some.id}`, { body: { pinned: true } });

  const created = await call('POST', '/api/posts', { token, body: { title: `Simulated post ${i}`, body: 'Created by scripts/simulate.mjs' } });
  if (created?.id) {
    await call('PUT', `/api/posts/${created.id}`, { token, body: { title: `Simulated post ${i} (edited)`, body: 'Edited' } });
    if (Math.random() < 0.6) await call('DELETE', `/api/posts/${created.id}`, { token });
  }
  const remote = 1 + Math.floor(Math.random() * 10);
  await call('PUT', `/api/posts/${remote}`, { token, body: { title: `Edited remote post ${remote}`, body: 'Edited' } });
  if (Math.random() < 0.3) await call('DELETE', `/api/posts/${remote}`, { token });
  if (Math.random() < 0.2) await call('DELETE', `/api/posts/${remote}`); // anonymous attempt → 401
}

console.log(`simulating ${rounds} rounds against ${BASE} …`);
for (let i = 1; i <= rounds; i++) {
  try {
    await round(i);
    process.stdout.write(`  round ${i}/${rounds} done\n`);
  } catch (err) {
    console.error(`  round ${i} failed: ${err.message} (is the stack running? npm start)`);
    process.exit(1);
  }
}
await call('POST', '/api/admin/reset');
console.log('\nresponses:');
for (const [k, v] of [...statuses].sort()) console.log(`  ${String(v).padStart(4)} × ${k}`);
console.log('\ntraces are in telemetry/traces/ (wait a few seconds for the indexer to finish)');
