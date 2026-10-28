// Minimal OpenTelemetry-style tracing with no dependencies.
//
// Spans follow the OTel semantic conventions and are written as OTLP JSON, one document
// per line, to telemetry/traces/<service>.jsonl — the same shape an OTel Collector's
// file exporter produces. Context propagates across services with the W3C `traceparent`
// header (HTTP) or a `traceparent` field (queue messages).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const TRACE_DIR = path.resolve(process.env.TRACE_DIR || 'telemetry/traces');
const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
const context = new AsyncLocalStorage();

const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function attr(key, v) {
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return { key, value: { stringValue: String(v) } };
}

export function templatePath(p) {
  return p.split('?')[0].split('/').map((s) => (/^\d+$/.test(s) ? ':id' : s)).join('/');
}

function parseTraceparent(header) {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header || '');
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

export function createTelemetry(service) {
  const enabled = process.env.TRACING !== 'off';
  const file = path.join(TRACE_DIR, `${service}.jsonl`);
  if (enabled) fs.mkdirSync(TRACE_DIR, { recursive: true });

  // parent: undefined = current context, null = start a new trace
  function startSpan(name, kind, attributes, parent) {
    const p = parent === undefined ? context.getStore() : parent;
    return {
      traceId: p ? p.traceId : randomHex(16),
      spanId: randomHex(8),
      parentSpanId: p ? p.spanId : '',
      name, kind, attributes: { ...attributes }, start: nowNs(), error: false,
    };
  }

  function endSpan(span, attributes = {}) {
    if (!enabled) return;
    Object.assign(span.attributes, attributes);
    const doc = {
      resourceSpans: [{
        resource: { attributes: [attr('service.name', service)] },
        scopeSpans: [{
          scope: { name: 'postboard/telemetry' },
          spans: [{
            traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
            name: span.name, kind: KIND[span.kind],
            startTimeUnixNano: String(span.start), endTimeUnixNano: String(nowNs()),
            attributes: Object.entries(span.attributes).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => attr(k, v)),
            status: span.error ? { code: 2 } : {},
          }],
        }],
      }],
    };
    fs.appendFileSync(file, JSON.stringify(doc) + '\n');
  }

  const traceparentOf = (span) => `00-${span.traceId}-${span.spanId}-01`;

  return {
    // Wraps an incoming HTTP request (used by shared/router.mjs).
    serverSpan(req, res, route, fn) {
      const span = startSpan(`${req.method} ${route}`, 'SERVER', {
        'http.request.method': req.method,
        'http.route': route,
        'url.path': req.path,
      }, parseTraceparent(req.headers.traceparent));
      res.on('finish', () => {
        span.error = res.statusCode >= 500;
        endSpan(span, { 'http.response.status_code': res.statusCode });
      });
      return context.run(span, fn);
    },

    // fetch() with a CLIENT span and traceparent propagation.
    async fetch(url, options = {}) {
      const u = new URL(url);
      const method = (options.method || 'GET').toUpperCase();
      const span = startSpan(method, 'CLIENT', {
        'http.request.method': method,
        'url.full': u.origin + u.pathname, // no query string
        'server.address': u.hostname,
        'server.port': u.port ? Number(u.port) : undefined,
      });
      const headers = { ...(options.headers || {}), traceparent: traceparentOf(span) };
      try {
        const res = await fetch(url, { ...options, headers });
        span.error = res.status >= 500;
        endSpan(span, { 'http.response.status_code': res.status });
        return res;
      } catch (err) {
        span.error = true;
        endSpan(span, { 'error.type': err.name });
        throw err;
      }
    },

    // Synchronous database call (node:sqlite) with a CLIENT span.
    db(operation, table, fn) {
      const span = startSpan(`${operation} ${table}`, 'CLIENT', {
        'db.system': 'sqlite', 'db.namespace': 'posts.db',
        'db.operation.name': operation, 'db.collection.name': table,
      });
      try {
        const result = fn();
        endSpan(span);
        return result;
      } catch (err) {
        span.error = true;
        endSpan(span, { 'error.type': err.name });
        throw err;
      }
    },

    // Publish a message; fn receives the traceparent to embed in the message.
    async producer(destination, fn) {
      const span = startSpan(`${destination} publish`, 'PRODUCER', {
        'messaging.system': 'postboard-bus', 'messaging.destination.name': destination, 'messaging.operation.type': 'publish',
      });
      try {
        return await context.run(span, () => fn(traceparentOf(span)));
      } catch (err) {
        span.error = true;
        throw err;
      } finally {
        endSpan(span);
      }
    },

    // Process a received message as a child of the span that published it.
    async consumer(destination, traceparent, fn) {
      const span = startSpan(`${destination} process`, 'CONSUMER', {
        'messaging.system': 'postboard-bus', 'messaging.destination.name': destination, 'messaging.operation.type': 'process',
      }, parseTraceparent(traceparent));
      try {
        return await context.run(span, fn);
      } catch (err) {
        span.error = true;
        throw err;
      } finally {
        endSpan(span);
      }
    },
  };
}
