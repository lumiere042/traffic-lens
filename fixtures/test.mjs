// Sanity tests: route handling + trace-format parity (OTLP vs Jaeger vs Zipkin).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRoute, templatePath, matchRoute, bestMatch } from '../traffic-lens/scripts/lib/paths.mjs';
import { tracesToEvents, detectTraceFormat } from '../traffic-lens/scripts/lib/otel.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- paths ----------
assert.equal(normalizeRoute('/orders/{orderId}'), '/orders/:orderId');
assert.equal(normalizeRoute('/orders/<int:id>/items'), '/orders/:id/items');
assert.equal(normalizeRoute('/orders/[id]'), '/orders/:id');
assert.equal(normalizeRoute('/files/[...slug]'), '/files/:slug*');
assert.equal(normalizeRoute('/orders/${order.id}?x=1'), '/orders/:id');
assert.equal(normalizeRoute('/users/${post.userId}'), '/users/:userId');
assert.equal(normalizeRoute('/users/${encodeURIComponent(req.params.id)}'), '/users/:id');
assert.equal(normalizeRoute('https://api.x.com/v1/a/'), '/v1/a');
assert.equal(templatePath('/orders/8812'), '/orders/:id');
assert.equal(templatePath('/orders/550e8400-e29b-41d4-a716-446655440000/items'), '/orders/:id/items');
assert.equal(templatePath('/users/me'), '/users/me');
assert.ok(matchRoute('/orders/:id', '/orders/123') >= 0);
assert.ok(matchRoute('/orders/:id', '/orders/123/items') < 0);
assert.ok(matchRoute('/files/*', '/files/a/b/c') >= 0);
const eps = [{ method: 'GET', path: '/orders/:id' }, { method: 'GET', path: '/orders/latest' }];
assert.equal(bestMatch(eps, { method: 'GET', path: '/orders/latest' }).item.path, '/orders/latest');
assert.equal(bestMatch(eps, { method: 'POST', path: '/orders/1' }).methodMismatch, true);
// a templated call prefers the param route over a literal sibling, whatever the order
assert.equal(bestMatch(eps, { method: 'GET', path: '/orders/:orderId' }).item.path, '/orders/:id');
assert.equal(bestMatch([...eps].reverse(), { method: 'GET', path: '/orders/:orderId' }).item.path, '/orders/:id');

// ---------- trace formats ----------
const otlpDocs = fs.readFileSync(path.join(dir, 'traces.otlp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const flat = [];
for (const d of otlpDocs) for (const rs of d.resourceSpans) {
  const service = rs.resource.attributes.find((a) => a.key === 'service.name').value.stringValue;
  for (const ss of rs.scopeSpans) for (const s of ss.spans) flat.push({ service, s });
}
const attrsObj = (s) => Object.fromEntries(s.attributes.map((a) => [a.key, a.value.stringValue ?? Number(a.value.intValue)]));
const KIND = { 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer' };

const jaeger = { data: [] };
const byTrace = new Map();
for (const { service, s } of flat) {
  if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, { traceID: s.traceId, spans: [], processes: {} });
  const t = byTrace.get(s.traceId);
  const pid = 'p-' + service;
  t.processes[pid] = { serviceName: service, tags: [] };
  const tags = Object.entries(attrsObj(s)).map(([key, value]) => ({ key, type: typeof value === 'number' ? 'int64' : 'string', value }));
  tags.push({ key: 'span.kind', type: 'string', value: KIND[s.kind] || 'internal' });
  if (s.status && s.status.code === 2) tags.push({ key: 'error', type: 'bool', value: true });
  t.spans.push({ traceID: s.traceId, spanID: s.spanId, operationName: s.name, processID: pid,
    references: s.parentSpanId ? [{ refType: 'CHILD_OF', traceID: s.traceId, spanID: s.parentSpanId }] : [],
    startTime: Number(BigInt(s.startTimeUnixNano) / 1000n), duration: Number((BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000n), tags });
}
jaeger.data = [...byTrace.values()];

const zipkin = flat.map(({ service, s }) => ({
  traceId: s.traceId, id: s.spanId, parentId: s.parentSpanId || undefined, name: s.name,
  kind: (KIND[s.kind] || '').toUpperCase() || undefined,
  timestamp: Number(BigInt(s.startTimeUnixNano) / 1000n), duration: Number((BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000n),
  localEndpoint: { serviceName: service },
  tags: Object.fromEntries(Object.entries(attrsObj(s)).map(([k, v]) => [k, String(v)]).concat(s.status && s.status.code === 2 ? [['error', 'true']] : [])),
}));

assert.equal(detectTraceFormat(otlpDocs), 'otlp');
assert.equal(detectTraceFormat(jaeger), 'jaeger');
assert.equal(detectTraceFormat(zipkin), 'zipkin');
assert.equal(detectTraceFormat({ batches: [] }), 'otlp');

const summarize = (events) => {
  const m = new Map();
  for (const e of events) {
    const k = `${e.source} -> ${e.target} ${e.method} ${e.route}${e.async ? ' async' : ''}`;
    const v = m.get(k) || { n: 0, err: 0 };
    v.n++; if (e.error) v.err++;
    m.set(k, v);
  }
  return Object.fromEntries([...m].sort());
};
const a = summarize(tracesToEvents(otlpDocs, 'otlp').events);
const b = summarize(tracesToEvents([jaeger], 'jaeger').events);
const c = summarize(tracesToEvents(zipkin, 'zipkin').events);
assert.deepEqual(b, a, 'jaeger parity');
assert.deepEqual(c, a, 'zipkin parity');
console.log('pairs:', Object.keys(a).length);
for (const [k, v] of Object.entries(a)) console.log(' ', k.padEnd(70), v);
fs.writeFileSync(path.join(dir, 'jaeger-export.json'), JSON.stringify(jaeger));
console.log('\nall tests passed (wrote jaeger-export.json)');
