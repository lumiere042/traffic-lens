// Route normalization, templating and matching.
//
// Code routes come in many dialects (/orders/{id}, /orders/<int:id>, /orders/[id],
// /orders/${id}); observed traffic has concrete values (/orders/8812). Everything is
// normalized to ":param" segments so the two sides can be compared.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const HEXISH = /^[0-9a-f]{12,}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_\-=.~]{16,}$/; // long tokens/ids that mix in digits

export function stripQuery(path) {
  if (!path) return '';
  const i = path.search(/[?#]/);
  return i === -1 ? path : path.slice(0, i);
}

// Normalize a *declared* route from code into canonical ":param" form.
export function normalizeRoute(path) {
  if (path == null) return '';
  let p = stripQuery(String(path).trim());
  if (!p) return '';
  if (/^[a-z]+:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { /* keep as-is */ }
  }
  if (!p.startsWith('/')) p = '/' + p;
  p = p
    .replace(/\$\{\s*([^}]*?)\s*\}/g, (_, n) => ':' + exprParamName(n)) // ${post.userId} (template literal)
    .replace(/\{\s*([^}:]+)(?::[^}]*)?\s*\}/g, (_, n) => ':' + paramName(n)) // {id} or {id:int}
    .replace(/<(?:[^:>]+:)?([^>]+)>/g, (_, n) => ':' + paramName(n))   // <int:id> / <id>
    .replace(/\[\[?\.\.\.([^\]]+)\]?\]/g, (_, n) => ':' + paramName(n) + '*') // [...slug]
    .replace(/\[([^\]]+)\]/g, (_, n) => ':' + paramName(n));           // [id]
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

// `${post.userId}` → userId, `${encodeURIComponent(req.params.id)}` → id
const WRAPPERS = new Set(['encodeURIComponent', 'encodeURI', 'String', 'Number', 'parseInt', 'toString', 'trim']);
function exprParamName(expr) {
  const ids = (String(expr).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter((x) => !WRAPPERS.has(x));
  return ids.length ? ids[ids.length - 1].replace(/\$/g, '') || 'param' : 'param';
}

function paramName(raw) {
  const n = String(raw).replace(/^[^A-Za-z_]*/, '').replace(/[^A-Za-z0-9_].*$/, '');
  return n || 'param';
}

// Turn a concrete observed path into a template by replacing id-like segments.
export function templatePath(path) {
  const p = normalizeRoute(path);
  if (!p) return '';
  const segs = p.split('/').map((s, i) => {
    if (i === 0 || s === '' || s.startsWith(':')) return s;
    let d = s;
    try { d = decodeURIComponent(s); } catch { /* keep raw */ }
    const ext = d.match(/^(.+)(\.[A-Za-z0-9]{1,5})$/);
    if (ext && (NUMERIC.test(ext[1]) || UUID.test(ext[1]) || /^[0-9a-f]{8,}$/i.test(ext[1]) || OPAQUE.test(ext[1]))) return ':id' + ext[2];
    if (NUMERIC.test(d) || UUID.test(d) || HEXISH.test(d) || OPAQUE.test(d)) return ':id';
    if (DATE.test(d)) return ':date';
    if (d.includes('@')) return ':email';
    return s;
  });
  return segs.join('/');
}

const isParam = (s) => s.startsWith(':') || s === '*';
const isCatchAll = (s) => s === '*' || (s.startsWith(':') && s.endsWith('*'));

// Does a declared route pattern match a (templated or concrete) path?
// Returns a specificity score or -1. Per segment: literal = literal scores 2, param = param
// scores 1, literal vs param scores 0 — so GET /posts/:id prefers /posts/:id over
// /posts/search, while a concrete /posts/search still prefers /posts/search.
export function matchRoute(pattern, path) {
  const a = normalizeRoute(pattern).split('/');
  const b = normalizeRoute(path).split('/');
  let score = 0;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    if (isCatchAll(pa)) return score;
    if (i >= b.length) return -1;
    const pb = b[i];
    if (isParam(pa) && isParam(pb)) { score += 1; continue; }
    if (isParam(pa) || isParam(pb)) continue;
    if (pa.toLowerCase() !== pb.toLowerCase()) return -1;
    score += 2;
  }
  return a.length === b.length ? score : -1;
}

const ANY_METHODS = new Set(['', '*', 'ANY', 'ALL']);

export function methodsMatch(a, b) {
  const x = String(a || '').toUpperCase();
  const y = String(b || '').toUpperCase();
  return ANY_METHODS.has(x) || ANY_METHODS.has(y) || x === y;
}

// Find the best endpoint/call in `list` for {method, path, operation}.
// Returns { item, methodMismatch } or null.
export function bestMatch(list, call) {
  let best = null;
  let bestScore = -1;
  let pathOnly = null;
  for (const item of list || []) {
    if (item.operation && call.operation && item.operation !== call.operation) continue;
    const s = matchRoute(item.path || '', call.path || '');
    if (s < 0) continue;
    if (!methodsMatch(item.method, call.method)) { pathOnly = pathOnly || item; continue; }
    if (s > bestScore) { best = item; bestScore = s; }
  }
  if (best) return { item: best, methodMismatch: false };
  if (pathOnly) return { item: pathOnly, methodMismatch: true };
  return null;
}

// Collapse high-cardinality literal segments (slugs, usernames) into ":param".
// Works on a list of {method, path} keys and returns a Map oldPath -> newPath.
export function collapseCardinality(calls, threshold = 8) {
  const remap = new Map();
  const groups = new Map();
  for (const c of calls) {
    const segs = c.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      if (isParam(segs[i])) continue;
      const key = c.method + ' ' + segs.length + ' ' + i + ' ' + segs.map((s, j) => (j === i ? '*' : s)).join('/');
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(c.path);
    }
  }
  for (const [key, paths] of groups) {
    if (paths.size < threshold) continue;
    const i = Number(key.split(' ')[2]);
    for (const p of paths) {
      const segs = (remap.get(p) || p).split('/');
      segs[i] = ':param';
      remap.set(p, segs.join('/'));
    }
  }
  return remap;
}
