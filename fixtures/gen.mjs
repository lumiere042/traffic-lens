// Generates fixtures/checkout.har and fixtures/traces.otlp.jsonl with deterministic data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');

// ---------- HAR ----------
const t0 = Date.parse('2026-10-20T10:00:00Z');
const entries = [];
const add = (method, url, status, time, type = 'fetch', headers = []) => entries.push({
  startedDateTime: new Date(t0 + entries.length * 900).toISOString(), time, _resourceType: type,
  request: { method, url, headers, cookies: [] },
  response: { status, content: { mimeType: type === 'fetch' ? 'application/json' : 'text/javascript' } },
});
const bearer = [{ name: 'Authorization', value: 'Bearer eyJhbGciOi.redacted' }];
for (let i = 0; i < 30; i++) add('GET', 'https://api.shop.dev/products?page=' + i, 200, 40 + rnd() * 60);
for (let i = 0; i < 40; i++) add('GET', `https://api.shop.dev/products/${1000 + Math.floor(rnd() * 400)}`, 200, 30 + rnd() * 50);
for (let i = 0; i < 25; i++) add('POST', 'https://api.shop.dev/cart/items', rnd() < 0.04 ? 500 : 201, 60 + rnd() * 90);
for (let i = 0; i < 12; i++) add('POST', 'https://api.shop.dev/checkout', i % 5 === 2 ? 502 : 200, 400 + rnd() * 1400, 'fetch', bearer);
add('POST', 'https://api.shop.dev/checkout', 200, 380, 'fetch'); // no credentials but succeeded -> finding
for (let i = 0; i < 18; i++) add('GET', `https://api.shop.dev/orders/${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`, 200, 50 + rnd() * 80, 'fetch', bearer);
for (let i = 0; i < 20; i++) add('POST', 'http://api.segment.io/v1/track', 200, 20 + rnd() * 30, 'xhr');
add('OPTIONS', 'https://api.shop.dev/checkout', 204, 5, 'preflight');
for (const f of ['main.js', 'vendor.js', 'app.css', 'logo.svg']) add('GET', 'https://shop.dev/_next/static/' + f, 200, 12, f.endsWith('.js') ? 'script' : 'stylesheet');
fs.writeFileSync(path.join(dir, 'checkout.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'fixture' }, pages: [], entries } }, null, 1));

// ---------- OTLP ----------
const lines = [];
const attr = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) } }));
function emitTrace(kind, n = 0) {
  const traceId = hex(32);
  const spans = []; // [service, span]
  let clock = t0 * 1e6 + Math.floor(rnd() * 3.6e12);
  const span = (service, name, k, parent, attrs, durMs, error = false) => {
    const s = { traceId, spanId: hex(16), parentSpanId: parent ? parent.spanId : '', name, kind: k,
      startTimeUnixNano: String(clock), endTimeUnixNano: String(clock + Math.round(durMs * 1e6)), attributes: attr(attrs), status: error ? { code: 2 } : {} };
    clock += 1e6;
    spans.push([service, s]);
    return s;
  };
  if (kind === 'checkout') {
    const failPay = n % 12 === 5;
    const root = span('gateway', 'POST /checkout', 2, null, { 'http.request.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': failPay ? 502 : 200 }, 900, failPay);
    const c1 = span('gateway', 'POST', 3, root, { 'http.request.method': 'POST', 'server.address': 'auth', 'server.port': 4001 }, 15);
    span('auth', 'POST /tokens/verify', 2, c1, { 'http.request.method': 'POST', 'http.route': '/tokens/verify', 'http.response.status_code': 200 }, 12);
    const c2 = span('gateway', 'POST', 3, root, { 'http.request.method': 'POST', 'server.address': 'shop-api', 'server.port': 4000 }, 850);
    const s2 = span('shop-api', 'POST /checkout', 2, c2, { 'http.request.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': failPay ? 502 : 200 }, 840, failPay);
    span('shop-api', 'INSERT orders', 3, s2, { 'db.system': 'postgresql', 'db.operation.name': 'INSERT', 'db.collection.name': 'orders', 'server.address': 'orders-db', 'server.port': 5432 }, 8);
    span('shop-api', 'POST', 3, s2, { 'http.request.method': 'POST', 'url.full': 'https://api.stripe.com/v1/payment_intents', 'server.address': 'api.stripe.com', 'http.response.status_code': failPay ? 503 : 200 }, 600 + rnd() * 900, failPay);
    // fraud check: not in the code graph -> undocumented connection
    span('shop-api', 'GET', 3, s2, { 'http.request.method': 'GET', 'url.full': 'https://risk.internal:9000/score', 'server.address': 'risk.internal', 'server.port': 9000, 'http.response.status_code': 200 }, 40);
    if (!failPay) {
      const p = span('shop-api', 'order.created publish', 4, s2, { 'messaging.system': 'kafka', 'messaging.destination.name': 'order-events', 'messaging.operation.type': 'publish' }, 3);
      const c = span('orders-worker', 'order.created process', 5, p, { 'messaging.system': 'kafka', 'messaging.destination.name': 'order-events', 'messaging.operation.type': 'process' }, 250);
      span('orders-worker', 'UPDATE orders', 3, c, { 'db.system': 'postgresql', 'db.operation.name': 'UPDATE', 'db.collection.name': 'orders', 'server.address': 'orders-db', 'server.port': 5432 }, 6);
      span('orders-worker', 'PUT', 3, c, { 'http.request.method': 'PUT', 'url.full': `https://receipts.s3.amazonaws.com/receipts/${hex(10)}.pdf`, 'server.address': 'receipts.s3.amazonaws.com', 'http.response.status_code': 200 }, 120);
    }
  } else {
    const root = span('gateway', 'GET /orders/:id', 2, null, { 'http.request.method': 'GET', 'http.route': '/orders/:id', 'http.response.status_code': 200 }, 60);
    const c2 = span('gateway', 'GET', 3, root, { 'http.request.method': 'GET', 'server.address': 'shop-api', 'server.port': 4000 }, 50);
    const s2 = span('shop-api', 'GET /orders/:id', 2, c2, { 'http.request.method': 'GET', 'http.route': '/orders/:id', 'http.response.status_code': 200 }, 45);
    span('shop-api', 'GET', 3, s2, { 'db.system': 'redis', 'db.operation.name': 'GET', 'server.address': 'redis', 'server.port': 6379 }, 1.2);
    if (rnd() < 0.3) span('shop-api', 'SELECT orders', 3, s2, { 'db.system': 'postgresql', 'db.operation.name': 'SELECT', 'db.collection.name': 'orders', 'server.address': 'orders-db', 'server.port': 5432 }, 9);
  }
  const byService = new Map();
  for (const [svc, s] of spans) { if (!byService.has(svc)) byService.set(svc, []); byService.get(svc).push(s); }
  lines.push(JSON.stringify({ resourceSpans: [...byService].map(([svc, ss]) => ({
    resource: { attributes: attr({ 'service.name': svc }) }, scopeSpans: [{ scope: { name: 'fixture' }, spans: ss }] })) }));
}
for (let i = 0; i < 60; i++) emitTrace('checkout', i);
for (let i = 0; i < 140; i++) emitTrace('order');
fs.writeFileSync(path.join(dir, 'traces.otlp.jsonl'), lines.join('\n') + '\n');
console.log('wrote', entries.length, 'HAR entries and', lines.length, 'traces');
