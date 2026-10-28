// Aggregate traffic events into edges with stats and merge them into the code graph.

import { bestMatch, collapseCardinality, matchRoute, methodsMatch } from './paths.mjs';
import { slug, percentile, isLocalHost } from './util.mjs';

export const INBOUND_ID = '__inbound';

// ---------- stats accumulators ----------

function newAcc() {
  return { count: 0, errors: 0, client_errors: 0, durations: [], auth: {}, unauth_ok: 0, insecure: 0, first: null, last: null };
}

function addEvent(acc, ev) {
  acc.count++;
  if (ev.error) acc.errors++;
  else if (ev.status >= 400 && ev.status < 500) acc.client_errors++;
  if (typeof ev.duration_ms === 'number') acc.durations.push(ev.duration_ms);
  if (ev.auth) {
    acc.auth[ev.auth] = (acc.auth[ev.auth] || 0) + 1;
    if (ev.auth === 'none' && ev.status >= 200 && ev.status < 400) acc.unauth_ok++;
  }
  if (ev.insecure) acc.insecure++;
  if (ev.ts) {
    if (!acc.first || ev.ts < acc.first) acc.first = ev.ts;
    if (!acc.last || ev.ts > acc.last) acc.last = ev.ts;
  }
}

function mergeAcc(into, from) {
  into.count += from.count;
  into.errors += from.errors;
  into.client_errors += from.client_errors;
  into.durations.push(...from.durations);
  for (const [k, v] of Object.entries(from.auth)) into.auth[k] = (into.auth[k] || 0) + v;
  into.unauth_ok += from.unauth_ok;
  into.insecure += from.insecure;
  if (from.first && (!into.first || from.first < into.first)) into.first = from.first;
  if (from.last && (!into.last || from.last > into.last)) into.last = from.last;
  return into;
}

function finalize(acc) {
  const d = acc.durations.slice().sort((a, b) => a - b);
  return {
    count: acc.count,
    errors: acc.errors,
    client_errors: acc.client_errors,
    error_rate: acc.count ? Math.round((acc.errors / acc.count) * 10000) / 10000 : 0,
    p50: percentile(d, 50),
    p95: percentile(d, 95),
    auth: Object.keys(acc.auth).length ? acc.auth : null,
    unauth_ok: acc.unauth_ok,
    insecure: acc.insecure,
    first: acc.first,
    last: acc.last,
  };
}

// ---------- name -> node resolution ----------

// On a loopback host the port *is* the service (localhost:3000 vs localhost:4002), so the
// port is only dropped for other hosts (orders:8080 -> orders).
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/;

function nameKeys(name) {
  const n = String(name).toLowerCase().trim();
  const noPort = n.replace(/:(\d+)$/, '');
  if (noPort !== n && LOOPBACK.test(noPort)) return [...new Set([n, slug(n)])];
  return [...new Set([n, noPort, slug(n), slug(noPort)])];
}

// "orders.default.svc.cluster.local" or "risk.internal" -> "orders" / "risk". Only for
// private names: public hosts share first labels too often (api.stripe.com, api.segment.io).
function shortName(name) {
  const host = String(name).toLowerCase().trim().replace(/:(\d+)$/, '');
  if (!/[a-z]/.test(host) || !host.includes('.') || !isLocalHost(host)) return null;
  return host.split('.')[0];
}

function buildResolver(graph) {
  const hasCodeNodes = graph.nodes.length > 0;
  const index = new Map();
  const add = (key, id) => { if (!index.has(key)) index.set(key, id); };
  for (const n of graph.nodes) {
    // exact aliases win over fuzzy keys, so index them first
    for (const a of [n.id, n.label, ...n.aliases]) add(String(a).toLowerCase(), n.id);
  }
  for (const n of graph.nodes) {
    for (const a of [n.id, n.label, ...n.aliases]) for (const k of nameKeys(a)) add(k, n.id);
  }

  const created = [];
  return {
    created,
    resolve(name, hint = {}) {
      for (const k of nameKeys(name)) if (index.has(k)) return index.get(k);
      const short = shortName(name);
      if (short && index.has(short)) return index.get(short);
      let id = slug(name.replace(/:(80|443)$/, ''));
      while (graph.nodes.some((n) => n.id === id)) id += '-x';
      const node = {
        id,
        label: name.replace(/:(80|443)$/, ''),
        kind: hint.kind || 'external',
        tech: hint.tech || (hasCodeNodes ? 'Discovered in traffic' : ''),
        group: null,
        aliases: [name],
        endpoints: [],
        discovered: true,
      };
      graph.nodes.push(node);
      created.push(node);
      for (const k of nameKeys(name)) add(k, id);
      return id;
    },
  };
}

function kindHint(ev, side) {
  if (side === 'source') return ev.source_kind || (ev.origin === 'har' ? 'client' : 'service');
  if (ev.target_kind) return ev.target_kind;
  if (ev.origin === 'otel') return 'service';
  return isLocalHost(ev.target) ? 'service' : 'external';
}

// ---------- aggregation ----------

const callKey = (c) => `${c.method} ${c.path}#${c.operation || ''}`;

function aggregate(events, resolver) {
  const edges = new Map();
  let selfCalls = 0;
  for (const ev of events) {
    const src = ev.source === '*' ? '*' : resolver.resolve(ev.source, { kind: kindHint(ev, 'source') });
    const tgt = resolver.resolve(ev.target, { kind: kindHint(ev, 'target'), tech: ev.target_tech });
    if (src === tgt) { selfCalls++; continue; }
    ev._src = src;
    ev._tgt = tgt;
    const ek = src + '->' + tgt;
    if (!edges.has(ek)) edges.set(ek, { source: src, target: tgt, protocol: ev.protocol, async: ev.async, calls: new Map() });
    const edge = edges.get(ek);
    if (ev.async) edge.async = true;
    const call = { method: ev.method || '', path: ev.route || ev.path || '', operation: ev.operation || null };
    const ck = callKey(call);
    if (!edge.calls.has(ck)) edge.calls.set(ck, { ...call, protocol: ev.protocol, _acc: newAcc() });
    addEvent(edge.calls.get(ck)._acc, ev);
    ev._call = ck;
  }

  // collapse slug-like segments that templating could not recognise
  for (const edge of edges.values()) {
    const remap = collapseCardinality([...edge.calls.values()]);
    if (!remap.size) continue;
    const merged = new Map();
    const keyMap = new Map();
    for (const [ck, c] of edge.calls) {
      const next = { ...c, path: remap.get(c.path) || c.path };
      const nk = callKey(next);
      keyMap.set(ck, nk);
      if (merged.has(nk)) mergeAcc(merged.get(nk)._acc, c._acc);
      else merged.set(nk, next);
    }
    edge.calls = merged;
    for (const ev of events) if (ev._src === edge.source && ev._tgt === edge.target && keyMap.has(ev._call)) ev._call = keyMap.get(ev._call);
  }
  return { edges, selfCalls };
}

// ---------- merge ----------

export function mergeTraffic(graph, events) {
  const resolver = buildResolver(graph);
  const { edges: tEdges, selfCalls } = aggregate(events, resolver);
  const inboundTo = new Map(); // `${target} ${callKey}` -> source node actually used

  for (const e of graph.edges) e.observed = 'code';
  for (const e of graph.edges) for (const c of e.calls) c.observed = 'code';

  const findEdge = (s, t) => graph.edges.find((e) => e.source === s && e.target === t);

  const attachCall = (edge, tCall) => {
    const m = bestMatch(edge.calls.filter((c) => c.observed !== 'traffic'), tCall);
    if (m && !m.methodMismatch) {
      const c = m.item;
      c._acc = c._acc ? mergeAcc(c._acc, tCall._acc) : tCall._acc;
      c.observed = 'both';
      return c;
    }
    const existing = edge.calls.find((c) => c.observed === 'traffic' && callKey(c) === callKey(tCall));
    if (existing) { mergeAcc(existing._acc, tCall._acc); return existing; }
    const c = { method: tCall.method, path: tCall.path, operation: tCall.operation, observed: 'traffic', locations: [], _acc: tCall._acc };
    edge.calls.push(c);
    return c;
  };

  const ensureEdge = (s, t, proto) => {
    let e = findEdge(s, t);
    if (!e) {
      e = { source: s, target: t, protocol: proto.protocol || 'http', async: Boolean(proto.async), confidence: 'high', calls: [], observed: 'traffic' };
      graph.edges.push(e);
    } else if (e.observed === 'code') e.observed = 'both';
    return e;
  };

  for (const t of tEdges.values()) {
    if (t.source !== '*') {
      const e = ensureEdge(t.source, t.target, t);
      for (const c of t.calls.values()) c._graphCall = attachCall(e, c);
      continue;
    }
    // Unknown caller (root span / un-instrumented client): credit the code edge that
    // declares this call, otherwise draw it from a synthetic "Inbound traffic" node.
    for (const [ck, c] of t.calls) {
      const owner = graph.edges.find((e) => e.target === t.target && e.observed !== 'traffic' && (() => {
        const m = bestMatch(e.calls, c);
        return m && !m.methodMismatch;
      })());
      let src = owner ? owner.source : INBOUND_ID;
      if (!owner && !graph.nodes.some((n) => n.id === INBOUND_ID)) {
        graph.nodes.push({ id: INBOUND_ID, label: 'Inbound traffic', kind: 'client', tech: 'Callers outside the traces', group: null, aliases: [], endpoints: [], discovered: true });
      }
      const e = ensureEdge(src, t.target, t);
      c._graphCall = attachCall(e, c);
      inboundTo.set(t.target + ' ' + ck, src);
    }
  }

  // finalize stats on calls and edges
  for (const e of graph.edges) {
    const total = newAcc();
    let any = false;
    for (const c of e.calls) {
      if (c._acc) { c.stats = finalize(c._acc); mergeAcc(total, c._acc); any = true; delete c._acc; }
    }
    if (any) e.stats = finalize(total);
  }

  // how many times each call happens inside one traced request (N+1 detection)
  const perTrace = new Map(); // graph call -> Map(trace -> count)
  for (const ev of events) {
    if (!ev.trace_id || ev._src === undefined) continue;
    const gc = tEdges.get(ev._src + '->' + ev._tgt)?.calls.get(ev._call)?._graphCall;
    if (!gc) continue;
    if (!perTrace.has(gc)) perTrace.set(gc, new Map());
    const m = perTrace.get(gc);
    m.set(ev.trace_id, (m.get(ev.trace_id) || 0) + 1);
  }
  for (const [gc, m] of perTrace) {
    const counts = [...m.values()];
    const max = Math.max(...counts);
    if (max >= 2 && gc.stats) {
      gc.stats.per_request = { max, avg: Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10, traces: counts.length };
    }
  }

  const trafficFlows = buildTrafficFlows(events, inboundTo);
  return { createdNodes: resolver.created, selfCalls, trafficFlows };
}

// ---------- flows from traces ----------

function buildTrafficFlows(events, inboundTo) {
  const traces = new Map();
  for (const ev of events) {
    if (!ev.trace_id || ev._src === undefined) continue;
    if (!traces.has(ev.trace_id)) traces.set(ev.trace_id, []);
    traces.get(ev.trace_id).push(ev);
  }
  const flows = new Map();
  for (const [traceId, evs] of traces) {
    evs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const root = evs.find((e) => e.root) || evs[0];
    const rootCall = root._call.split('#')[0];
    const key = root._tgt + ' ' + rootCall;
    if (!flows.has(key)) {
      const [method, ...rest] = rootCall.split(' ');
      flows.set(key, { entry: { node: root._tgt, method, path: rest.join(' ') }, steps: [], count: 0, errors: 0, calls: [], traces: [] });
    }
    const f = flows.get(key);
    f.count++;
    if (evs.some((e) => e.error)) f.errors++;
    f.calls.push(evs.length);
    for (const ev of evs) {
      const src = ev._src === '*' ? inboundTo.get(ev._tgt + ' ' + ev._call) : ev._src;
      if (!src) continue;
      const step = `${src}->${ev._tgt}`;
      if (!f.steps.includes(step)) f.steps.push(step);
    }
    f.traces.push({ traceId, evs });
  }
  return [...flows.values()]
    .filter((f) => f.steps.length > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
    .map((f) => {
      const samples = pickSamples(f.traces.map((t) => toWaterfall(t.traceId, t.evs, inboundTo)));
      const { traces: _t, calls, ...rest } = f;
      return {
        ...rest,
        calls_per_request: Math.round((calls.reduce((a, b) => a + b, 0) / calls.length) * 10) / 10,
        calls_max: Math.max(...calls),
        samples,
      };
    });
}

// One trace as a waterfall: each cross-service call with its offset from the start of the
// request, its duration and its depth (nesting is inferred from who called whom and when).
function toWaterfall(traceId, evs, inboundTo) {
  const t0 = Math.min(...evs.map((e) => Date.parse(e.ts)));
  const spans = evs.map((ev) => {
    const src = ev._src === '*' ? inboundTo.get(ev._tgt + ' ' + ev._call) || ev._src : ev._src;
    const start = Date.parse(ev.ts) - t0;
    return {
      edge: `${src}->${ev._tgt}`, src, tgt: ev._tgt,
      call: ev._call.split('#')[0] + (ev.operation ? ` (${ev.operation})` : ''),
      start, duration: ev.duration_ms ?? 0, status: ev.status ?? null, error: Boolean(ev.error), async: Boolean(ev.async),
    };
  }).sort((a, b) => a.start - b.start || b.duration - a.duration);
  for (const s of spans) {
    // parent: the latest earlier call that landed on this call's source and was still running
    // (async hops may start after their producer finished)
    let parent = null;
    for (const p of spans) {
      if (p === s || p.tgt !== s.src || p.start > s.start) continue;
      if (!s.async && p.start + p.duration + 2 < s.start) continue;
      if (!parent || p.start >= parent.start) parent = p;
    }
    s.depth = parent ? parent.depth + 1 : 0;
  }
  const end = Math.max(...spans.map((s) => s.start + s.duration));
  return { trace_id: traceId, duration: Math.round(end * 10) / 10, error: spans.some((s) => s.error), spans };
}

// slowest, a typical (median) one, and one that failed — enough to explain the flow
function pickSamples(all) {
  if (!all.length) return [];
  const byTime = [...all].sort((a, b) => b.duration - a.duration);
  const picks = [
    { ...byTime[0], label: 'slowest' },
    { ...byTime[Math.floor(byTime.length / 2)], label: 'typical' },
  ];
  const failed = byTime.find((t) => t.error);
  if (failed) picks.push({ ...failed, label: 'failed' });
  const seen = new Set();
  return picks.filter((p) => !seen.has(p.trace_id) && seen.add(p.trace_id));
}

export function mergeFlows(codeFlows, trafficFlows) {
  const out = codeFlows.map((f) => ({ ...f, steps: [...(f.steps || [])], observed: 'code' }));
  for (const tf of trafficFlows) {
    // best-scoring entry, so /api/posts/search traces land on Search, not on /api/posts/:id
    let match = null;
    let best = -1;
    for (const f of out) {
      if (!f.entry || f.entry.node !== tf.entry.node || !methodsMatch(f.entry.method, tf.entry.method)) continue;
      const s = matchRoute(f.entry.path || '', tf.entry.path);
      if (s > best) { best = s; match = f; }
    }
    const tStats = { count: tf.count, errors: tf.errors, calls_per_request: tf.calls_per_request, calls_max: tf.calls_max };
    if (match) {
      match.observed = 'both';
      const prev = match.stats || { count: 0, errors: 0, calls_per_request: 0, calls_max: 0 };
      const count = prev.count + tf.count;
      match.stats = {
        count,
        errors: prev.errors + tf.errors,
        calls_per_request: Math.round(((prev.calls_per_request * prev.count + tf.calls_per_request * tf.count) / count) * 10) / 10,
        calls_max: Math.max(prev.calls_max, tf.calls_max),
      };
      match.samples = pickSamples([...(match.samples || []), ...tf.samples]);
      for (const s of tf.steps) if (!match.steps.includes(s)) match.steps.push(s);
    } else {
      out.push({
        id: slug(`${tf.entry.method}-${tf.entry.node}-${tf.entry.path}`),
        name: `${tf.entry.method} ${tf.entry.path}`,
        description: `Reconstructed from ${tf.count} trace${tf.count === 1 ? '' : 's'}`,
        entry: tf.entry,
        steps: tf.steps,
        observed: 'traffic',
        stats: tStats,
        samples: tf.samples,
      });
    }
  }
  return out;
}
