// Findings: security, contract, health and structure checks over the merged graph.

import { bestMatch, methodsMatch } from './paths.mjs';
import { MUTATING, NO_AUTH, isLocalHost } from './util.mjs';
import { INBOUND_ID } from './traffic.mjs';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
const ROUTED = new Set(['http', 'graphql', 'grpc', 'websocket', 'sse']);
const UNKNOWN_AUTH = new Set(['', 'unknown', null, undefined]);
const SENSITIVE_PATH = /(^|\/)(admin|internal|debug|private|manage(ment)?|actuator|metrics|_?ops)(\/|$)/i;
// Routes that are public by nature (anonymous users must reach them) — not flagged as open.
const PUBLIC_BY_DESIGN = /(^|\/)(log-?in|sign-?in|sign-?up|register|log-?out|sign-?out|oauth|callback|token|forgot-password|reset-password|health|healthz|ready|readyz|live|livez|ping|status)(\/|$)/i;
const SYNC_RPC = new Set(['http', 'graphql', 'grpc']);
const N_PLUS_ONE = 5;
const CHATTY = 15;

const callLabel = (c) => `${c.method || ''} ${c.path || ''}${c.operation ? ` (${c.operation})` : ''}`.trim();
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

export function analyze(graph, { hasTraffic, hadCodeEdges, errorRate = 0.05, slowMs = 1000 }) {
  const findings = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const isOutside = (id) => id === INBOUND_ID || ['client', 'external'].includes(nodes.get(id)?.kind);
  const add = (f) => findings.push({ nodes: [], edges: [], items: [], ...f });
  const label = (id) => nodes.get(id)?.label ?? id;
  const isPublicByDesign = (route) => route.public === true || PUBLIC_BY_DESIGN.test(route.path || '');

  // ---------- security ----------
  const openWrites = new Map();
  const openReads = new Map();
  // items keyed by route so the same route found via a call and via its declaration is listed once
  const record = (map, nodeId, label, edgeId, evidence = '') => {
    if (!map.has(nodeId)) map.set(nodeId, { items: new Map(), edges: new Set() });
    const v = map.get(nodeId);
    if (!v.items.has(label) || evidence) v.items.set(label, label + evidence);
    if (edgeId) v.edges.add(edgeId);
  };

  for (const e of graph.edges) {
    const target = nodes.get(e.target);
    if (!target) continue;
    const owned = target.kind !== 'external'; // third-party APIs aren't ours to secure
    for (const c of e.calls) {
      const ep = target.endpoints.length ? bestMatch(target.endpoints, c) : null;
      const declared = ep && !ep.methodMismatch ? ep.item.auth : undefined;
      const auth = declared ?? c.auth;

      const routeForAuth = ep && !ep.methodMismatch ? ep.item : c;
      if (owned && isOutside(e.source) && NO_AUTH.has(auth) && !isPublicByDesign(routeForAuth)) {
        const route = routeForAuth;
        const risky = MUTATING.has(c.method) || SENSITIVE_PATH.test(route.path || '');
        const evidence = risky && c.stats && c.stats.unauth_ok ? `  — ${c.stats.unauth_ok} request(s) succeeded without credentials` : '';
        // a catch-all route says nothing on its own: name the actual call and what let it through
        const label = /\*/.test(route.path || '') ? `${callLabel(c)} (via ${callLabel(route)})` : callLabel(route);
        record(risky ? openWrites : openReads, e.target, label, e.id, evidence);
      }
      if (c.stats && c.stats.unauth_ok > 0 && !UNKNOWN_AUTH.has(auth) && !NO_AUTH.has(auth)) {
        add({
          severity: 'high', category: 'security',
          title: `${target.label} accepted unauthenticated requests`,
          key: `noauth-accepted:${e.id}:${callLabel(c)}`,
          detail: `${callLabel(c)} is expected to carry "${auth}" auth, but ${c.stats.unauth_ok} request(s) without credentials succeeded in captured traffic.`,
          nodes: [e.target], edges: [e.id],
        });
      }
    }
    // plain HTTP: from observed traffic, or from the URL as written in code (browsers
    // silently upgrade many hosts to HTTPS, so traffic alone misses these)
    const plainInCode = e.calls.filter((c) => {
      const url = String(c.url || '');
      if (/^http:\/\//i.test(url)) {
        try { return !isLocalHost(new URL(url).hostname); } catch { return false; }
      }
      return c.scheme === 'http' && target.kind === 'external';
    });
    if ((e.stats && e.stats.insecure > 0) || plainInCode.length) {
      const evidence = [];
      if (e.stats && e.stats.insecure > 0) evidence.push(`${e.stats.insecure} request(s) observed over http://`);
      for (const c of plainInCode) evidence.push(`${c.url || callLabel(c)}${c.locations?.length ? `  — ${c.locations[0]}` : ''}`);
      add({
        severity: 'medium', category: 'security',
        title: `Plain-text HTTP from ${label(e.source)} to ${target.label}`,
        key: `plain-http:${e.id}`,
        detail: 'Unencrypted http:// to a non-local host: anything on the network path can read or alter the traffic. Use https://.',
        items: evidence, nodes: [e.source, e.target], edges: [e.id],
      });
    }
    if (target.exposure === 'internal' && isOutside(e.source)) {
      add({
        severity: e.source === INBOUND_ID ? 'medium' : 'high', category: 'security',
        title: `Internal ${target.kind} ${target.label} is reachable from outside`,
        key: `internal-exposed:${e.id}`,
        detail: `${nodes.get(e.source)?.label} (${nodes.get(e.source)?.kind}) calls ${target.label}, which is marked internal-only.`,
        nodes: [e.source, e.target], edges: [e.id],
      });
    }
  }
  // declared-but-uncalled public endpoints with no auth
  for (const n of graph.nodes) {
    if (n.exposure !== 'public') continue;
    for (const ep of n.endpoints) {
      if (NO_AUTH.has(ep.auth) && !isPublicByDesign(ep) && (MUTATING.has(ep.method) || SENSITIVE_PATH.test(ep.path))) record(openWrites, n.id, callLabel(ep));
    }
  }
  // wildcard CORS on something that isn't meant for browsers
  for (const n of graph.nodes) {
    const wild = n.endpoints.filter((ep) => ep.cors === '*' && (n.exposure === 'internal' || SENSITIVE_PATH.test(ep.path) || !NO_AUTH.has(ep.auth ?? 'none')));
    if (!wild.length) continue;
    add({
      severity: 'medium', category: 'security',
      title: `Wildcard CORS on ${n.label}`,
      key: `cors:${n.id}`,
      detail: n.exposure === 'internal'
        ? 'Access-Control-Allow-Origin: * lets any website\'s scripts read these responses from an internal service — usually a dev shortcut that should not ship.'
        : 'Access-Control-Allow-Origin: * on sensitive or authenticated routes lets any origin read them.',
      items: wild.map((ep) => `${callLabel(ep)}${ep.location ? `  — ${ep.location}` : ''}`), nodes: [n.id],
    });
  }
  for (const [id, v] of openWrites) {
    add({
      severity: 'high', category: 'security',
      title: `Unauthenticated sensitive routes on ${nodes.get(id).label}`,
      key: `open-sensitive:${id}`,
      detail: 'These state-changing or admin/internal routes are reachable from clients without credentials. Confirm each one is meant to be public (e.g. sign-up, webhooks with signature checks).',
      items: [...v.items.values()], nodes: [id], edges: [...v.edges],
    });
  }
  for (const [id, v] of openReads) {
    add({
      severity: 'low', category: 'security',
      title: `Public read endpoints on ${nodes.get(id).label}`,
      key: `open-read:${id}`,
      detail: 'Readable without credentials. Usually fine for catalog/content data; make sure none return user-specific data.',
      items: [...v.items.values()], nodes: [id], edges: [...v.edges],
    });
  }

  // ---------- contract ----------
  const usedEndpoints = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  for (const e of graph.edges) {
    const target = nodes.get(e.target);
    if (!target || !target.endpoints.length || !ROUTED.has(e.protocol)) continue;
    const missing = [];
    let codeMissing = false;
    for (const c of e.calls) {
      if (!c.path) continue;
      if (/(^|\/)(\*|:[^/]*\*)$/.test(c.path)) {
        // a proxy forwarding everything (ANY /*) uses every route it can reach
        for (const ep of target.endpoints) if (methodsMatch(ep.method, c.method)) usedEndpoints.get(target.id).add(ep);
        continue;
      }
      const m = bestMatch(target.endpoints, c);
      if (m && !m.methodMismatch) { usedEndpoints.get(target.id).add(m.item); continue; }
      const seen = c.stats ? `  — seen ${c.stats.count}×${c.stats.client_errors ? `, ${c.stats.client_errors} returned 4xx` : ''}` : '';
      missing.push(callLabel(c) + (m ? `  — ${target.label} only defines ${m.item.method} for this path` : '') + seen);
      if (c.observed !== 'traffic') codeMissing = true;
    }
    if (missing.length) {
      add({
        severity: codeMissing ? 'high' : 'medium', category: 'contract',
        title: `${nodes.get(e.source)?.label} calls routes ${target.label} doesn't define`,
        key: `missing-routes:${e.id}`,
        detail: codeMissing
          ? 'The caller\'s code references endpoints that are not declared on the target — likely a broken contract (renamed route, wrong method, stale client).'
          : 'Seen in traffic but not found among the target\'s declared routes — the scan may have missed a route, or a proxy rewrites paths.',
        items: missing, nodes: [e.source, e.target], edges: [e.id],
      });
    }
  }
  for (const n of graph.nodes) {
    if (!n.endpoints.length || n.kind === 'external') continue;
    const unused = n.endpoints.filter((ep) => !usedEndpoints.get(n.id).has(ep));
    if (!unused.length) continue;
    add({
      severity: n.exposure === 'public' ? 'info' : 'low', category: 'contract',
      title: `${unused.length} route${unused.length === 1 ? '' : 's'} on ${n.label} never called`,
      key: `unused:${n.id}`,
      detail: n.exposure === 'public'
        ? 'No caller in this system uses these routes. They may serve third parties — otherwise they are dead code and attack surface.'
        : 'No caller in this system uses these routes. Candidates for removal.',
      items: unused.map(callLabel), nodes: [n.id],
    });
  }
  if (hasTraffic && hadCodeEdges) {
    for (const e of graph.edges) {
      if (e.observed !== 'traffic' || e.source === INBOUND_ID) continue;
      add({
        severity: 'medium', category: 'contract',
        title: `Undocumented connection: ${nodes.get(e.source)?.label} → ${nodes.get(e.target)?.label}`,
        key: `undocumented:${e.id}`,
        detail: 'Seen in captured traffic but not found in the code scan. Could be config-driven URLs, a library making calls, or a service outside the scanned repos.',
        items: e.calls.slice(0, 8).map(callLabel), nodes: [e.source, e.target], edges: [e.id],
      });
    }
    // only callers we actually saw sending traffic can be expected to show their other calls
    const senders = new Set(graph.edges.filter((e) => e.stats).map((e) => e.source));
    const unobserved = graph.edges.filter((e) => e.observed === 'code' && senders.has(e.source));
    if (unobserved.length) {
      add({
        severity: 'info', category: 'contract',
        title: `${unobserved.length} connection${unobserved.length === 1 ? '' : 's'} never observed in traffic`,
        key: "unobserved",
        detail: 'Present in code, from callers that do send traffic in the capture, but never exercised. Either the capture missed those paths or the code is dead.',
        items: unobserved.map((e) => `${nodes.get(e.source)?.label} → ${nodes.get(e.target)?.label}`),
        edges: unobserved.map((e) => e.id),
      });
    }
  }

  // ---------- health ----------
  if (hasTraffic) {
    for (const e of graph.edges) {
      const failing = e.calls.filter((c) => c.stats && c.stats.count >= 5 && c.stats.error_rate >= errorRate);
      if (failing.length) {
        const worst = Math.max(...failing.map((c) => c.stats.error_rate));
        add({
          severity: worst >= 0.2 ? 'high' : 'medium', category: 'health',
          title: `Errors on ${nodes.get(e.source)?.label} → ${nodes.get(e.target)?.label}`,
          key: `errors:${e.id}`,
          detail: `Error rate above ${pct(errorRate)} (5xx, failed or errored spans).`,
          items: failing.map((c) => `${callLabel(c)}  — ${pct(c.stats.error_rate)} of ${c.stats.count}`),
          nodes: [e.target], edges: [e.id],
        });
      }
      const slow = e.calls.filter((c) => c.stats && c.stats.p95 != null && c.stats.p95 >= slowMs);
      if (slow.length) {
        const worst = Math.max(...slow.map((c) => c.stats.p95));
        add({
          severity: worst >= slowMs * 3 ? 'medium' : 'low', category: 'health',
          title: `Slow calls: ${nodes.get(e.source)?.label} → ${nodes.get(e.target)?.label}`,
          key: `slow:${e.id}`,
          detail: `p95 latency at or above ${slowMs} ms.`,
          items: slow.map((c) => `${callLabel(c)}  — p95 ${Math.round(c.stats.p95)} ms`),
          nodes: [e.target], edges: [e.id],
        });
      }
    }
  }

  // N+1: the same call repeated many times inside one request — measured in traces, or
  // declared by the scan (loop: the call sits inside a per-item loop in code)
  for (const e of graph.edges) {
    const repeated = e.calls.filter((c) => c.stats?.per_request && c.stats.per_request.max >= N_PLUS_ONE);
    const looped = e.calls.filter((c) => c.loop && !repeated.includes(c));
    if (!repeated.length && !looped.length) continue;
    const worst = repeated.length ? Math.max(...repeated.map((c) => c.stats.per_request.max)) : 0;
    add({
      severity: worst >= N_PLUS_ONE * 3 ? 'high' : 'medium', category: 'health',
      title: `N+1 calls: ${label(e.source)} → ${label(e.target)}`,
      key: `nplus1:${e.id}`,
      detail: 'One incoming request triggers the same call over and over (typically a lookup inside a loop). Batch it, cache it, or de-duplicate the ids first.' +
        (repeated.length ? '' : ' Found in code; traces would show how many times it repeats in practice.'),
      items: [
        ...repeated.map((c) => `${callLabel(c)}  — up to ${c.stats.per_request.max}× per request (avg ${c.stats.per_request.avg})`),
        ...looped.map((c) => `${callLabel(c)}  — once per item${typeof c.loop === 'string' ? ` of ${c.loop}` : ''}${c.locations?.length ? `  — ${c.locations[0]}` : ''}`),
      ],
      nodes: [e.source, e.target], edges: [e.id],
    });
  }
  // chatty flows: one user action fans out into many internal calls
  for (const f of graph.flows || []) {
    if (f.stats?.calls_per_request >= CHATTY) {
      add({
        severity: 'low', category: 'health',
        title: `Chatty flow: ${f.name || f.id}`,
        key: `chatty:${f.id}`,
        detail: `Each request makes about ${f.stats.calls_per_request} cross-service calls (max ${f.stats.calls_max}). Every hop adds latency and a failure point.`,
        nodes: [...new Set((f.steps || []).flatMap((s) => s.split('->')))].filter((id) => nodes.has(id)), edges: f.steps || [],
      });
    }
  }
  // outbound calls without a timeout (declared by the scan: timeout: "none")
  const noTimeout = new Map();
  for (const e of graph.edges) {
    // browsers enforce their own limits; this is about servers holding connections open
    if (e.async || !SYNC_RPC.has(e.protocol) || nodes.get(e.source)?.kind === 'client') continue;
    for (const c of e.calls) {
      if (c.timeout !== 'none' && c.timeout !== false) continue;
      if (!noTimeout.has(e.source)) noTimeout.set(e.source, { items: [], edges: new Set(), external: false });
      const v = noTimeout.get(e.source);
      v.items.push(`→ ${label(e.target)}: ${callLabel(c)}${c.locations?.length ? `  — ${c.locations[0]}` : ''}`);
      v.edges.add(e.id);
      if (nodes.get(e.target)?.kind === 'external') v.external = true;
    }
  }
  for (const [src, v] of noTimeout) {
    add({
      severity: v.external ? 'medium' : 'low', category: 'health',
      title: `No timeout on outbound calls from ${label(src)}`,
      key: `no-timeout:${src}`,
      detail: `If the other side hangs, ${label(src)} hangs with it and holds the caller's connection open.${v.external ? ' At least one target is a third party you don\'t control.' : ''}`,
      items: v.items, nodes: [src], edges: [...v.edges],
    });
  }

  // ---------- structure ----------
  // single points of failure: nodes that (almost) every flow depends on
  const flows = (graph.flows || []).filter((f) => f.steps?.length);
  if (flows.length >= 3) {
    const counts = new Map();
    for (const f of flows) {
      const touched = new Set(f.steps.flatMap((s) => s.split('->')));
      for (const id of touched) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const spof = [...counts].filter(([id, n]) => nodes.has(id) && id !== INBOUND_ID &&
      nodes.get(id).kind !== 'client' && n / flows.length >= 0.8).sort((a, b) => b[1] - a[1]);
    if (spof.length) {
      add({
        severity: 'info', category: 'structure',
        title: `Single points of failure: ${spof.map(([id]) => label(id)).join(', ')}`,
        key: "spof",
        detail: 'Most request flows pass through these. If one is down or slow, so is nearly everything — make sure each has redundancy, health checks and sensible timeouts.',
        items: spof.map(([id, n]) => `${label(id)} — in ${n} of ${flows.length} flows`), nodes: spof.map(([id]) => id),
      });
    }
  }
  for (const scc of stronglyConnected(graph.nodes.map((n) => n.id), graph.edges.filter((e) => !e.async))) {
    if (scc.length < 2) continue;
    const set = new Set(scc);
    add({
      severity: 'medium', category: 'structure',
      title: `Synchronous call cycle between ${scc.map((id) => nodes.get(id)?.label).join(', ')}`,
      key: `cycle:${[...scc].sort().join(",")}`,
      detail: 'These services call each other synchronously. A slowdown in one can cascade around the loop, and they cannot be deployed or scaled independently.',
      nodes: scc, edges: graph.edges.filter((e) => !e.async && set.has(e.source) && set.has(e.target)).map((e) => e.id),
    });
  }
  for (const n of graph.nodes) {
    const outs = graph.edges.filter((e) => e.source === n.id);
    if (outs.length >= 8 && !['client', 'gateway'].includes(n.kind)) {
      add({
        severity: 'info', category: 'structure',
        title: `${n.label} fans out to ${outs.length} dependencies`,
        key: `fanout:${n.id}`,
        detail: 'A high number of direct dependencies makes this service sensitive to any of them failing. Consider whether some calls can be async or aggregated.',
        nodes: [n.id], edges: outs.map((e) => e.id),
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  findings.forEach((f, i) => { f.id = `f${i + 1}`; });
  return findings;
}

function stronglyConnected(ids, edges) {
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges) adj.get(e.source)?.push(e.target);
  let index = 0;
  const stack = [];
  const on = new Set();
  const idx = new Map();
  const low = new Map();
  const out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return out;
}
