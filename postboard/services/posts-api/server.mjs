import { createApp } from '../../shared/router.mjs';
import { createTelemetry } from '../../shared/telemetry.mjs';
import { db, LOCAL_ID_START } from './db.mjs';

const PORT = Number(process.env.PORT || 4002);
const PLACEHOLDER_API = process.env.PLACEHOLDER_API || 'https://jsonplaceholder.typicode.com';
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4001';
const BUS_URL = process.env.BUS_URL || 'http://localhost:4003';

const telemetry = createTelemetry('posts-api');
const app = createApp({ telemetry });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- data access ----------
const localRows = () => telemetry.db('SELECT', 'posts', () => db.prepare('select * from posts').all());
const localRow = (id) => telemetry.db('SELECT', 'posts', () => db.prepare('select * from posts where id = ?').get(id));

function upsert(id, fields) {
  const existing = localRow(id);
  const row = { id, user_id: null, title: null, body: null, pinned: 0, indexed: 0, deleted: 0, ...existing, ...fields, updated_at: new Date().toISOString() };
  telemetry.db('INSERT', 'posts', () => db.prepare(
    `insert or replace into posts (id, user_id, title, body, pinned, indexed, deleted, updated_at)
     values (:id, :user_id, :title, :body, :pinned, :indexed, :deleted, :updated_at)`,
  ).run(row));
  return row;
}

function overlay(post, row) {
  if (!row) return { ...post, pinned: false };
  return {
    id: post.id,
    userId: row.user_id ?? post.userId,
    title: row.title ?? post.title,
    body: row.body ?? post.body,
    pinned: Boolean(row.pinned),
  };
}

const fromRow = (row) => ({ id: row.id, userId: row.user_id, title: row.title, body: row.body, pinned: Boolean(row.pinned) });

async function upstream(path, options = {}) {
  const res = await telemetry.fetch(`${PLACEHOLDER_API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...(options.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function publish(type, post) {
  await telemetry.producer('post.events', (traceparent) =>
    fetch(`${BUS_URL}/topics/post.events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, post, traceparent }),
    }),
  );
}

async function mergedPosts(filter = {}) {
  const query = filter.userId ? `?userId=${encodeURIComponent(filter.userId)}` : '?_limit=12';
  const { body: remote = [] } = await upstream(`/posts${query}`);
  const rows = new Map(localRows().map((r) => [r.id, r]));
  const posts = (remote || [])
    .filter((p) => !rows.get(p.id)?.deleted)
    .map((p) => overlay(p, rows.get(p.id)));
  for (const row of rows.values()) {
    if (row.id >= LOCAL_ID_START && !row.deleted && (!filter.userId || String(row.user_id) === String(filter.userId))) {
      posts.push(fromRow(row));
    }
  }
  return posts.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
}

// ---------- routes ----------
app.get('/health', (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.json(200, { ok: true, service: 'posts-api' });
});

app.get('/posts', async (req, res) => {
  const posts = await mergedPosts({ userId: req.query.userId });
  // show the author's name in the list
  await Promise.all(posts.map(async (post) => {
    const author = await telemetry.fetch(`${AUTH_URL}/users/${post.userId}`);
    post.author = author.ok ? await author.json() : null;
  }));
  res.json(200, posts);
});

app.get('/posts/search', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  // naive full-text search: pull every post and scan it
  const { body: all = [] } = await upstream('/posts');
  const rows = localRows();
  await sleep(1200); // stands in for the slow scoring pass
  const hits = [...(all || []), ...rows.filter((r) => r.id >= LOCAL_ID_START && !r.deleted).map(fromRow)]
    .filter((p) => `${p.title} ${p.body}`.toLowerCase().includes(q));
  res.json(200, hits.slice(0, 20));
});

app.get('/posts/export', async (req, res) => {
  res.json(200, localRows());
});

app.get('/posts/:id', async (req, res) => {
  const id = Number(req.params.id);
  let post;
  if (id >= LOCAL_ID_START) {
    const row = localRow(id);
    if (!row || row.deleted) return res.json(404, { error: 'Post not found' });
    post = fromRow(row);
  } else {
    const { ok, body } = await upstream(`/posts/${id}`);
    const row = localRow(id);
    if (!ok || row?.deleted) return res.json(404, { error: 'Post not found' });
    post = overlay(body, row);
  }
  const author = await telemetry.fetch(`${AUTH_URL}/users/${post.userId}`);
  post.author = author.ok ? await author.json() : null;
  res.json(200, post);
});

app.get('/posts/:id/comments', async (req, res) => {
  const { ok, body } = await upstream(`/posts/${Number(req.params.id)}/comments`);
  if (!ok) return res.json(502, { error: 'comments unavailable' });
  res.json(200, body);
});

app.post('/posts', async (req, res) => {
  const { title, body } = req.body || {};
  const userId = Number(req.headers['x-user-id']) || 1;
  if (!title) return res.json(400, { error: 'title is required' });
  await upstream('/posts', { method: 'POST', body: JSON.stringify({ title, body, userId }) });
  const nextId = Math.max(LOCAL_ID_START, ...localRows().map((r) => r.id + 1));
  const row = upsert(nextId, { user_id: userId, title, body });
  await publish('post.created', fromRow(row));
  res.json(201, fromRow(row));
});

app.put('/posts/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { title, body } = req.body || {};
  // JSONPlaceholder only knows ids 1-100; anything else answers 500
  const remote = await upstream(`/posts/${id}`, { method: 'PUT', body: JSON.stringify({ id, title, body }) });
  const row = upsert(id, { title, body });
  await publish('post.updated', fromRow(row));
  res.json(200, { ...fromRow(row), warning: remote.ok ? undefined : `upstream sync failed (${remote.status})` });
});

app.patch('/posts/:id', async (req, res) => {
  const id = Number(req.params.id);
  const row = upsert(id, { pinned: req.body?.pinned ? 1 : 0 });
  res.json(200, fromRow(row));
});

app.delete('/posts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id < LOCAL_ID_START) await upstream(`/posts/${id}`, { method: 'DELETE' });
  upsert(id, { deleted: 1 });
  await publish('post.deleted', { id });
  res.json(204);
});

app.put('/posts/:id/indexed', async (req, res) => {
  upsert(Number(req.params.id), { indexed: 1 });
  res.json(204);
});

app.post('/admin/reset', async (req, res) => {
  telemetry.db('DELETE', 'posts', () => db.exec('delete from posts'));
  res.json(200, { reset: true });
});

app.listen(PORT, () => console.log(`posts-api listening on :${PORT}`));
