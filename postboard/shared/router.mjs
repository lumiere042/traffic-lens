// A tiny Express-style router on node:http, so the demo has zero dependencies.
//   app.get('/posts/:id', handler) · app.all('/api/*', handler) · handlers are (req, res, next)

import http from 'node:http';
import { templatePath } from './telemetry.mjs';

function compile(method, pattern, handlers) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') { keys.push('wildcard'); return '(.*)'; }
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, pattern, keys, regex: new RegExp(`^${source}/?$`), handlers };
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

export function createApp({ telemetry } = {}) {
  const routes = [];
  let fallback = null;
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (pattern, ...handlers) => { routes.push(compile(m.toUpperCase(), pattern, handlers)); return app; };
  }
  app.all = (pattern, ...handlers) => { routes.push(compile('*', pattern, handlers)); return app; };
  // untraced GET handler for anything no route matched (static files)
  app.fallback = (fn) => { fallback = fn; return app; };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    res.json = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    const match = routes.find((r) => (r.method === req.method || r.method === '*') && r.regex.test(req.path));
    if (!match && fallback && req.method === 'GET') return fallback(req, res);

    const run = async () => {
      if (!match) {
        const hint = req.path === '/' && process.env.PUBLIC_URL
          ? `This is a backend API, not the website. Open ${process.env.PUBLIC_URL}`
          : undefined;
        return res.json(404, { error: `No route for ${req.method} ${req.path}`, hint });
      }
      const values = match.regex.exec(req.path).slice(1);
      req.params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i] || '')]));
      req.body = await readJson(req);
      let i = 0;
      const next = async () => {
        const h = match.handlers[i++];
        if (h) await h(req, res, next);
      };
      try {
        await next();
      } catch (err) {
        console.error(`${req.method} ${req.path} failed:`, err.message);
        res.json(500, { error: err.message });
      }
    };

    const route = match && !match.pattern.includes('*') ? match.pattern : templatePath(req.path);
    return telemetry ? telemetry.serverSpan(req, res, route, run) : run();
  }

  app.listen = (port, cb) => http.createServer(handle).listen(port, cb);
  return app;
}
