// Compare two built graphs (e.g. main vs a PR branch, or yesterday vs today).
// Returns the list of changes and a "union" graph — head plus whatever base had that head
// lost — annotated with `diff` markers so the viewer can draw it.

const routeKey = (c) => `${String(c.method || '').toUpperCase()} ${String(c.path || '').replace(/:[^/]+/g, ':')}#${c.operation || ''}`;
const callLabel = (c) => `${c.method || ''} ${c.path || ''}${c.operation ? ` (${c.operation})` : ''}`.trim();
// stable identity: titles can embed counts or lists ("2 routes …", "A, B, C") that change
const findingKey = (f) => f.key || `${f.category}|${f.title}`;

export function diffGraphs(base, head, opts = {}) {
  const errorJump = opts.errorJump ?? 0.05; // absolute error-rate increase that counts
  const slowerBy = opts.slowerBy ?? 1.5; // p95 ratio that counts
  const slowerMin = opts.slowerMinMs ?? 200; // ...and at least this many ms

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  const headEdges = new Map(head.edges.map((e) => [e.id, e]));
  const label = (id) => headNodes.get(id)?.label ?? baseNodes.get(id)?.label ?? id;
  const edgeLabel = (e) => `${label(e.source)} → ${label(e.target)}`;

  const changes = {
    nodes: {
      added: head.nodes.filter((n) => !baseNodes.has(n.id)).map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
      removed: base.nodes.filter((n) => !headNodes.has(n.id)).map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
    },
    edges: {
      added: head.edges.filter((e) => !baseEdges.has(e.id)).map((e) => ({ id: e.id, label: edgeLabel(e), routes: e.calls.map(callLabel) })),
      removed: base.edges.filter((e) => !headEdges.has(e.id)).map((e) => ({ id: e.id, label: edgeLabel(e), routes: e.calls.map(callLabel) })),
    },
    routes: [], // { edge, label, added:[], removed:[] }
    health: [], // { edge, label, kind: 'errors'|'latency', direction: 'worse'|'better', from, to, route }
    findings: { new: [], resolved: [] },
  };

  for (const he of head.edges) {
    const be = baseEdges.get(he.id);
    if (!be) continue;
    const bCalls = new Map(be.calls.map((c) => [routeKey(c), c]));
    const hCalls = new Map(he.calls.map((c) => [routeKey(c), c]));
    const added = he.calls.filter((c) => !bCalls.has(routeKey(c))).map(callLabel);
    const removed = be.calls.filter((c) => !hCalls.has(routeKey(c))).map(callLabel);
    if (added.length || removed.length) changes.routes.push({ edge: he.id, label: edgeLabel(he), added, removed });

    for (const [k, hc] of hCalls) {
      const bc = bCalls.get(k);
      if (!bc?.stats || !hc.stats) continue;
      const route = callLabel(hc);
      const de = hc.stats.error_rate - bc.stats.error_rate;
      if (Math.abs(de) >= errorJump) {
        changes.health.push({ edge: he.id, label: edgeLabel(he), route, kind: 'errors', direction: de > 0 ? 'worse' : 'better', from: bc.stats.error_rate, to: hc.stats.error_rate });
      }
      const bp = bc.stats.p95, hp = hc.stats.p95;
      if (bp != null && hp != null && Math.abs(hp - bp) >= slowerMin && (hp / Math.max(bp, 1) >= slowerBy || bp / Math.max(hp, 1) >= slowerBy)) {
        changes.health.push({ edge: he.id, label: edgeLabel(he), route, kind: 'latency', direction: hp > bp ? 'worse' : 'better', from: bp, to: hp });
      }
    }
  }

  const baseFindings = new Map(base.findings.map((f) => [findingKey(f), f]));
  const headFindings = new Map(head.findings.map((f) => [findingKey(f), f]));
  changes.findings.new = head.findings.filter((f) => !baseFindings.has(findingKey(f)));
  changes.findings.resolved = base.findings.filter((f) => !headFindings.has(findingKey(f)));
  // same finding, different affected items (e.g. 6 calls without a timeout → 1). Items are
  // compared without their "  — evidence" suffix, which carries run-dependent numbers.
  const subject = (item) => String(item).split('  — ')[0].replace(/:[A-Za-z_]\w*/g, ':');
  changes.findings.changed = [];
  for (const hf of head.findings) {
    const bf = baseFindings.get(findingKey(hf));
    if (!bf) continue;
    const before = new Set((bf.items || []).map(subject));
    const after = new Set((hf.items || []).map(subject));
    const itemsAdded = [...after].filter((x) => !before.has(x));
    const itemsRemoved = [...before].filter((x) => !after.has(x));
    if (itemsAdded.length || itemsRemoved.length) changes.findings.changed.push({ ...hf, itemsAdded, itemsRemoved });
  }

  // ---------- union graph for the viewer ----------
  const union = structuredClone(head);
  const changedEdges = new Set([...changes.routes.map((r) => r.edge), ...changes.health.map((h) => h.edge)]);
  for (const n of union.nodes) if (!baseNodes.has(n.id)) n.diff = 'added';
  for (const n of base.nodes) if (!headNodes.has(n.id)) union.nodes.push({ ...structuredClone(n), diff: 'removed' });
  for (const e of union.edges) {
    const be = baseEdges.get(e.id);
    if (!be) { e.diff = 'added'; continue; }
    if (changedEdges.has(e.id)) e.diff = 'changed';
    const hKeys = new Set(e.calls.map(routeKey));
    for (const c of e.calls) if (!be.calls.some((bc) => routeKey(bc) === routeKey(c))) c.diff = 'added';
    for (const bc of be.calls) if (!hKeys.has(routeKey(bc))) e.calls.push({ ...structuredClone(bc), diff: 'removed' });
    const regress = changes.health.filter((h) => h.edge === e.id);
    if (regress.length) e.health_change = regress;
  }
  for (const be of base.edges) if (!headEdges.has(be.id)) union.edges.push({ ...structuredClone(be), diff: 'removed' });
  const changedKeys = new Map(changes.findings.changed.map((f) => [findingKey(f), f]));
  for (const f of union.findings) {
    if (!baseFindings.has(findingKey(f))) f.diff = 'new';
    else if (changedKeys.has(findingKey(f))) {
      const c = changedKeys.get(findingKey(f));
      Object.assign(f, { diff: 'changed', itemsAdded: c.itemsAdded, itemsRemoved: c.itemsRemoved });
    }
  }
  let next = union.findings.length;
  for (const f of changes.findings.resolved) union.findings.push({ ...structuredClone(f), id: `r${++next}`, diff: 'resolved' });

  const summary = {
    nodesAdded: changes.nodes.added.length, nodesRemoved: changes.nodes.removed.length,
    edgesAdded: changes.edges.added.length, edgesRemoved: changes.edges.removed.length,
    edgesChanged: changes.routes.length,
    regressions: changes.health.filter((h) => h.direction === 'worse').length,
    improvements: changes.health.filter((h) => h.direction === 'better').length,
    findingsNew: changes.findings.new.length, findingsResolved: changes.findings.resolved.length,
    findingsChanged: changes.findings.changed.length,
  };
  summary.total = summary.nodesAdded + summary.nodesRemoved + summary.edgesAdded + summary.edgesRemoved +
    summary.edgesChanged + summary.regressions + summary.improvements + summary.findingsNew + summary.findingsResolved +
    summary.findingsChanged;

  union.meta = {
    ...head.meta,
    diff: {
      base: { title: base.title, generatedAt: base.meta?.generatedAt, label: opts.baseLabel || 'base' },
      head: { title: head.title, generatedAt: head.meta?.generatedAt, label: opts.headLabel || 'head' },
      summary,
    },
  };
  union.changes = changes;
  return { changes, summary, union };
}
