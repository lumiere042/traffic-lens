import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../shared/router.mjs';
import { createTelemetry } from '../../shared/telemetry.mjs';

const PORT = Number(process.env.PORT || 3000);
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4001';
const POSTS_URL = process.env.POSTS_URL || 'http://localhost:4002';
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

const telemetry = createTelemetry('gateway');
const app = createApp({ telemetry });

// Forward the request to another service, keeping method, query, body and auth.
const forward = (baseUrl, rewrite = (p) => p) => async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const target = `${baseUrl}${rewrite(req.path)}${qs ? `?${qs}` : ''}`;
  const headers = { 'content-type': 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.userId) headers['x-user-id'] = String(req.userId);
  const upstream = await telemetry.fetch(target, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
  res.end(text);
};

async function requireAuth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.json(401, { error: 'Sign in first' });
  const check = await telemetry.fetch(`${AUTH_URL}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!check.ok) return res.json(401, { error: 'Session expired, sign in again' });
  req.userId = (await check.json()).userId;
  await next();
}

const stripApi = (p) => p.replace(/^\/api/, '');

// ---------- auth ----------
app.post('/auth/login', forward(AUTH_URL, () => '/login'));
app.get('/auth/me', forward(AUTH_URL, () => '/me'));

// ---------- admin ----------
app.post('/api/admin/reset', forward(POSTS_URL, stripApi));

// ---------- posts ----------
app.post('/api/posts', requireAuth, forward(POSTS_URL, stripApi));
app.put('/api/posts/:id', requireAuth, forward(POSTS_URL, stripApi));
app.delete('/api/posts/:id', requireAuth, forward(POSTS_URL, stripApi));
app.all('/api/*', forward(POSTS_URL, stripApi));

// ---------- static frontend ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
app.fallback((req, res) => {
  const rel = req.path === '/' ? 'index.html' : req.path.slice(1);
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

app.listen(PORT, () => console.log(`gateway listening on http://localhost:${PORT}`));
