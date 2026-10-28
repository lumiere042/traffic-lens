// Distributed traces (OTLP JSON, Jaeger JSON, Zipkin v2 JSON) -> traffic events.
//
// Each span is normalized to a common shape, then turned into service-to-service
// events:
//   * a span whose parent lives in another service  -> parent.service -> span.service
//   * a CLIENT span with no cross-service child      -> service -> peer (db, cache, external API)
//   * PRODUCER / CONSUMER spans                      -> service -> topic -> consumer service
//   * a SERVER span with no parent                   -> "*" (unknown caller) -> service
// Only attributes needed for the map are kept (no SQL text, no URLs with query strings).

import { stripQuery, templatePath, normalizeRoute } from './paths.mjs';
import { isLocalHost } from './util.mjs';

const KIND_NAMES = { 0: 'INTERNAL', 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT', 4: 'PRODUCER', 5: 'CONSUMER' };

export function detectTraceFormat(doc) {
  const first = Array.isArray(doc) ? doc[0] : doc;
  if (!first || typeof first !== 'object') return null;
  if (first.resourceSpans || first.batches) return 'otlp';
  if (Array.isArray(first.data) && first.data[0] && first.data[0].spans) return 'jaeger';
  if (first.spans && first.processes) return 'jaeger';
  if (Array.isArray(first) && first[0] && first[0].traceId) return 'zipkin';
  if (first.traceId && (first.id || first.localEndpoint)) return 'zipkin';
  return null;
}

// ---------- normalization ----------

function otlpValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(otlpValue);
  return null;
}

function otlpAttrs(list) {
  const o = {};
  for (const a of list || []) o[a.key] = otlpValue(a.value);
  return o;
}

function fromOtlp(docs) {
  const spans = [];
  for (const doc of docs) {
    for (const rs of doc.resourceSpans || doc.batches || []) {
      const res = otlpAttrs(rs.resource && rs.resource.attributes);
      const service = res['service.name'] || 'unknown-service';
      for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
        for (const s of ss.spans || []) {
          const kind = typeof s.kind === 'number' ? KIND_NAMES[s.kind] : String(s.kind || '').replace('SPAN_KIND_', '');
          const start = Number(s.startTimeUnixNano) / 1e6;
          const end = Number(s.endTimeUnixNano) / 1e6;
          const code = s.status && s.status.code;
          spans.push({
            traceId: s.traceId, spanId: s.spanId, parentId: s.parentSpanId || null,
            service, name: s.name, kind: kind || 'INTERNAL',
            start, duration: end - start,
            attrs: otlpAttrs(s.attributes),
            error: code === 2 || code === 'STATUS_CODE_ERROR',
          });
        }
      }
    }
  }
  return spans;
}

function fromJaeger(docs) {
  const spans = [];
  const traces = [];
  for (const doc of docs) {
    if (Array.isArray(doc.data)) traces.push(...doc.data);
    else if (doc.spans) traces.push(doc);
  }
  for (const t of traces) {
    const procs = t.processes || {};
    for (const s of t.spans || []) {
      const attrs = {};
      for (const tag of s.tags || []) attrs[tag.key] = tag.value;
      const parentRef = (s.references || []).find((r) => r.refType === 'CHILD_OF') || (s.references || [])[0];
      const proc = procs[s.processID] || s.process || {};
      spans.push({
        traceId: s.traceID, spanId: s.spanID, parentId: parentRef ? parentRef.spanID : null,
        service: proc.serviceName || 'unknown-service', name: s.operationName,
        kind: String(attrs['span.kind'] || 'internal').toUpperCase(),
        start: Number(s.startTime) / 1000, duration: Number(s.duration) / 1000,
        attrs,
        error: attrs.error === true || attrs.error === 'true' || attrs['otel.status_code'] === 'ERROR',
      });
    }
  }
  return spans;
}

function fromZipkin(docs) {
  const flat = [];
  const walk = (x) => (Array.isArray(x) ? x.forEach(walk) : x && flat.push(x));
  walk(docs);
  return flat.map((s) => {
    const attrs = { ...(s.tags || {}) };
    if (s.remoteEndpoint && s.remoteEndpoint.serviceName) attrs['peer.service'] = s.remoteEndpoint.serviceName;
    return {
      traceId: s.traceId, spanId: s.id, parentId: s.parentId || null,
      service: (s.localEndpoint && s.localEndpoint.serviceName) || 'unknown-service', name: s.name,
      kind: String(s.kind || 'INTERNAL').toUpperCase(),
      start: Number(s.timestamp) / 1000, duration: Number(s.duration || 0) / 1000,
      attrs,
      error: 'error' in attrs,
    };
  });
}

// ---------- attribute helpers (old + new semantic conventions) ----------

const pick = (a, ...keys) => {
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== '') return a[k];
  return null;
};

function urlParts(a) {
  const full = pick(a, 'url.full', 'http.url');
  if (!full) return null;
  try { return new URL(full); } catch { return null; }
}

function describe(span) {
  const a = span.attrs;
  const url = urlParts(a);
  const dbSystem = pick(a, 'db.system.name', 'db.system');
  const msgSystem = pick(a, 'messaging.system');
  const rpcSystem = pick(a, 'rpc.system');
  const httpMethod = pick(a, 'http.request.method', 'http.method');

  let protocol = 'other';
  let method = null;
  let path = null;
  let route = null;
  let operation = null;
  let destination = null;
  let targetKind = null;

  if (msgSystem) {
    protocol = ['kafka', 'rabbitmq', 'aws_sqs', 'gcp_pubsub'].includes(msgSystem)
      ? { kafka: 'kafka', rabbitmq: 'amqp', aws_sqs: 'sqs', gcp_pubsub: 'pubsub' }[msgSystem] : 'queue';
    const op = String(pick(a, 'messaging.operation.type', 'messaging.operation') || '').toLowerCase();
    method = /publish|send|create/.test(op) || (!op && span.kind === 'PRODUCER') ? 'PUBLISH' : 'RECEIVE';
    // the topic/queue becomes the target node itself, so it is not repeated as the operation
    destination = pick(a, 'messaging.destination.name', 'messaging.destination') || null;
    targetKind = 'queue';
  } else if (dbSystem) {
    protocol = dbSystem === 'redis' || dbSystem === 'memcached' ? 'redis' : /mongo|dynamo|cassandra|couch|firestore/.test(dbSystem) ? 'nosql' : 'sql';
    const stmt = pick(a, 'db.query.text', 'db.statement');
    method = String(pick(a, 'db.operation.name', 'db.operation') || (typeof stmt === 'string' ? stmt.trim().split(/\s+/)[0] : 'QUERY') || 'QUERY').toUpperCase();
    operation = pick(a, 'db.collection.name', 'db.sql.table', 'db.mongodb.collection', 'db.cassandra.table') || null;
    targetKind = dbSystem === 'redis' || dbSystem === 'memcached' ? 'cache'
      : /elastic|opensearch|solr/.test(dbSystem) ? 'search' : 'database';
  } else if (rpcSystem) {
    protocol = rpcSystem === 'grpc' ? 'grpc' : 'other';
    method = 'RPC';
    const svc = pick(a, 'rpc.service');
    const m = pick(a, 'rpc.method');
    path = svc && m ? `/${svc}/${m}` : '/' + (span.name || '');
    route = path;
  } else if (httpMethod || url || pick(a, 'http.route', 'url.path', 'http.target')) {
    protocol = 'http';
    method = String(httpMethod || 'GET').toUpperCase();
    route = pick(a, 'http.route', 'url.template');
    path = stripQuery(pick(a, 'url.path', 'http.target') || (url ? url.pathname : '') || '');
    if (/graphql/i.test(route || path)) {
      protocol = 'graphql';
      operation = pick(a, 'graphql.operation.name') || null;
    }
  }

  const status = Number(pick(a, 'http.response.status_code', 'http.status_code') || 0) || null;
  const grpcStatus = pick(a, 'rpc.grpc.status_code');
  const error = span.error || (status != null && status >= 500) || (grpcStatus != null && Number(grpcStatus) !== 0);

  const peerHost = pick(a, 'server.address', 'net.peer.name', 'network.peer.address', 'net.sock.peer.name') || (url ? url.hostname : null);
  const peerPort = pick(a, 'server.port', 'net.peer.port') || (url && url.port ? url.port : null);
  const peer = pick(a, 'peer.service') || (peerHost ? (peerPort ? `${peerHost}:${peerPort}` : peerHost) : null) || dbSystem || msgSystem || null;
  const scheme = url ? url.protocol.replace(':', '') : pick(a, 'url.scheme', 'http.scheme');
  const insecure = scheme === 'http' && peerHost && !isLocalHost(peerHost);
  if (!targetKind && peerHost && /(^|\.)(s3[.-]|storage\.googleapis\.com$|blob\.core\.windows\.net$|r2\.cloudflarestorage\.com$)/.test(peerHost)) {
    targetKind = 'storage';
    if (protocol === 'http') protocol = 's3';
  }
  if (!targetKind && span.kind === 'CLIENT' && protocol === 'http' && peerHost && !isLocalHost(peerHost)) targetKind = 'external';

  return {
    protocol, method, operation, destination, status, error, peer, targetKind, insecure: Boolean(insecure),
    path: path ? normalizeRoute(path) : '',
    route: route ? normalizeRoute(route) : path ? templatePath(path) : '',
    tech: dbSystem || msgSystem || null,
  };
}

// ---------- spans -> events ----------

export function tracesToEvents(docs, format) {
  const spans = format === 'otlp' ? fromOtlp(docs) : format === 'jaeger' ? fromJaeger(docs) : fromZipkin(docs);
  const byId = new Map();
  const children = new Map();
  for (const s of spans) byId.set(s.traceId + '/' + s.spanId, s);
  for (const s of spans) {
    if (!s.parentId) continue;
    const k = s.traceId + '/' + s.parentId;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(s);
  }

  const events = [];
  const services = new Set();
  const emit = (span, source, target, d, extra = {}) => {
    events.push({
      origin: 'otel',
      source, target,
      target_kind: extra.target_kind ?? null,
      source_kind: extra.source_kind ?? null,
      target_tech: extra.target_tech ?? null,
      protocol: extra.protocol || d.protocol,
      async: Boolean(extra.async),
      method: d.method,
      path: d.path,
      route: d.route,
      operation: d.operation,
      status: d.status,
      error: d.error,
      duration_ms: Math.round(span.duration * 10) / 10,
      ts: new Date(span.start).toISOString(),
      trace_id: span.traceId,
      root: Boolean(extra.root),
      auth: null,
      insecure: d.insecure,
    });
  };

  for (const s of spans) {
    services.add(s.service);
    const parent = s.parentId ? byId.get(s.traceId + '/' + s.parentId) : null;
    const kids = children.get(s.traceId + '/' + s.spanId) || [];
    const d = describe(s);

    if (s.kind === 'PRODUCER') {
      if (d.destination) emit(s, s.service, d.destination, d, { async: true, target_kind: 'queue', target_tech: d.tech });
      else for (const k of kids.filter((k) => k.service !== s.service)) emit(k, s.service, k.service, d, { async: true });
      continue;
    }
    if (s.kind === 'CONSUMER') {
      if (d.destination) emit(s, d.destination, s.service, d, { async: true, root: !parent, source_kind: 'queue' });
      else if (!parent) emit(s, '*', s.service, d, { async: true, root: true });
      continue;
    }
    if (s.kind === 'SERVER') {
      if (parent && parent.service !== s.service && parent.kind !== 'PRODUCER') {
        emit(s, parent.service, s.service, d);
      } else if (!parent) {
        emit(s, '*', s.service, d, { root: true });
      }
      continue;
    }
    if (s.kind === 'CLIENT') {
      const crossKid = kids.some((k) => k.service !== s.service);
      if (!crossKid && d.peer) emit(s, s.service, d.peer, d, { target_kind: d.targetKind, target_tech: d.tech });
    }
  }

  return { events, stats: { spans: spans.length, traces: new Set(spans.map((s) => s.traceId)).size, services: [...services] } };
}
