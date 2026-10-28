import crypto from 'node:crypto';
import { createApp } from '../../shared/router.mjs';
import { createTelemetry } from '../../shared/telemetry.mjs';

const PORT = Number(process.env.PORT || 4001);
const PLACEHOLDER_API = process.env.PLACEHOLDER_API || 'https://jsonplaceholder.typicode.com';
const POSTS_URL = process.env.POSTS_URL || 'http://localhost:4002';
const SECRET = process.env.AUTH_SECRET || 'dev-secret';
const DEMO_PASSWORD = 'demo';
const TOKEN_TTL_MS = 60 * 60 * 1000;

const telemetry = createTelemetry('auth');
const app = createApp({ telemetry });

// ---------- tokens: base64url(payload).hmac ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function sign(user) {
  const payload = b64(JSON.stringify({ sub: user.id, username: user.username, name: user.name, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${hmac(payload)}`;
}

function verify(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || hmac(payload) !== sig) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return claims.exp > Date.now() ? claims : null;
}

const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// ---------- routes ----------
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (password !== DEMO_PASSWORD) return res.json(401, { error: 'Wrong password (hint: demo)' });
  const lookup = await telemetry.fetch(`${PLACEHOLDER_API}/users?username=${encodeURIComponent(username || '')}`, {
    signal: AbortSignal.timeout(5000),
  });
  const [user] = lookup.ok ? await lookup.json() : [];
  if (!user) return res.json(401, { error: `Unknown user ${username}` });
  res.json(200, { token: sign(user), user: { id: user.id, name: user.name, username: user.username } });
});

app.post('/verify', (req, res) => {
  const claims = verify(req.body?.token);
  if (!claims) return res.json(401, { error: 'invalid token' });
  res.json(200, { userId: claims.sub, username: claims.username });
});

app.post('/refresh', (req, res) => {
  const claims = verify(bearer(req));
  if (!claims) return res.json(401, { error: 'invalid token' });
  res.json(200, { token: sign({ id: claims.sub, username: claims.username, name: claims.name }) });
});

app.get('/users/:id', async (req, res) => {
  const r = await telemetry.fetch(`${PLACEHOLDER_API}/users/${encodeURIComponent(req.params.id)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return res.json(404, { error: 'user not found' });
  const u = await r.json();
  res.json(200, { id: u.id, name: u.name, username: u.username });
});

app.get('/me', async (req, res) => {
  const claims = verify(bearer(req));
  if (!claims) return res.json(401, { error: 'Sign in first' });
  const posts = await telemetry.fetch(`${POSTS_URL}/posts?userId=${claims.sub}`);
  const list = posts.ok ? await posts.json() : [];
  res.json(200, { id: claims.sub, name: claims.name, username: claims.username, postCount: list.length });
});

app.listen(PORT, () => console.log(`auth listening on :${PORT}`));
