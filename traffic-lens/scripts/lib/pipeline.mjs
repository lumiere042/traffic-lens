// The build pipeline as a function: validate the code graph, merge traffic events, assign
// ids, merge flows, run the analysis. Used by build.mjs, serve.mjs (live) and diff.mjs.

import { spawn } from 'node:child_process';
import { validateGraph } from './validate.mjs';
import { mergeTraffic, mergeFlows } from './traffic.mjs';
import { analyze } from './analyze.mjs';

export function buildGraph(input, events = [], opts = {}) {
  const errorRate = opts.errorRate ?? 0.05;
  const slowMs = opts.slowMs ?? 1000;
  // validateGraph normalizes into a fresh object, so the caller's input is never mutated
  const { graph, errors, warnings } = validateGraph(structuredClone(input || { nodes: [], edges: [] }));
  if (errors.length) return { graph: null, errors, warnings, created: [], selfCalls: 0 };
  if (opts.title) graph.title = opts.title;
  if (opts.subtitle) graph.subtitle = opts.subtitle;
  const hadCodeEdges = graph.edges.length > 0;

  const sources = [];
  if (input?.nodes?.length) sources.push('code');
  if (events.some((e) => e.origin === 'har')) sources.push('har');
  if (events.some((e) => e.origin === 'otel')) sources.push('otel');

  let trafficFlows = [];
  let created = [];
  let selfCalls = 0;
  if (events.length) {
    // events are annotated in place during the merge; work on copies so they can be reused
    const r = mergeTraffic(graph, events.map((e) => ({ ...e })));
    trafficFlows = r.trafficFlows;
    created = r.createdNodes;
    selfCalls = r.selfCalls;
  }

  const seen = new Map();
  for (const e of graph.edges) {
    const base = `${e.source}->${e.target}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    e.id = n === 1 ? base : `${base}#${n}`;
  }
  const ids = new Set(graph.edges.map((e) => e.id));
  graph.flows = mergeFlows(graph.flows, trafficFlows).map((f) => ({ ...f, steps: (f.steps || []).filter((s) => ids.has(s)) }));
  graph.findings = analyze(graph, { hasTraffic: events.length > 0, hadCodeEdges, errorRate, slowMs });

  graph.meta = {
    generatedAt: new Date().toISOString(),
    sources,
    requests: graph.edges.reduce((s, e) => s + (e.stats ? e.stats.count : 0), 0),
    errors: graph.edges.reduce((s, e) => s + (e.stats ? e.stats.errors : 0), 0),
    thresholds: { errorRate, slowMs },
    ...(opts.live ? { live: true } : {}),
  };
  return { graph, errors, warnings, created, selfCalls };
}

export function openInBrowser(target) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}
