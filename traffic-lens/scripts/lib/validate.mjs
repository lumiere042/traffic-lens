// Validate and normalize a code graph written by the agent. Errors stop the build;
// warnings are printed so the graph can be corrected, but the map still renders.

import { KINDS, PROTOCOLS } from './util.mjs';
import { normalizeRoute } from './paths.mjs';

export function validateGraph(input) {
  const errors = [];
  const warnings = [];
  const g = {
    title: input.title || 'Traffic map',
    subtitle: input.subtitle || '',
    groups: Array.isArray(input.groups) ? input.groups : [],
    nodes: [],
    edges: [],
    flows: Array.isArray(input.flows) ? input.flows : [],
    notes: Array.isArray(input.notes) ? input.notes : [],
  };

  if (!Array.isArray(input.nodes)) errors.push('graph.nodes must be an array');
  if (input.edges != null && !Array.isArray(input.edges)) errors.push('graph.edges must be an array');

  const groupIds = new Set();
  for (const grp of g.groups) {
    if (!grp.id) errors.push('every group needs an id');
    else groupIds.add(grp.id);
  }

  const ids = new Set();
  for (const [i, n] of (input.nodes || []).entries()) {
    if (!n || !n.id) { errors.push(`nodes[${i}] has no id`); continue; }
    if (ids.has(n.id)) { errors.push(`duplicate node id "${n.id}"`); continue; }
    ids.add(n.id);
    const kind = KINDS.includes(n.kind) ? n.kind : 'service';
    if (n.kind && !KINDS.includes(n.kind)) warnings.push(`node "${n.id}": unknown kind "${n.kind}", using "service" (valid: ${KINDS.join(', ')})`);
    if (n.group && !groupIds.has(n.group)) warnings.push(`node "${n.id}": group "${n.group}" is not declared in graph.groups`);
    g.nodes.push({
      ...n,
      kind,
      label: n.label || n.id,
      group: n.group && groupIds.has(n.group) ? n.group : null,
      aliases: Array.isArray(n.aliases) ? n.aliases.map(String) : [],
      endpoints: (Array.isArray(n.endpoints) ? n.endpoints : []).map((ep) => ({
        ...ep,
        method: String(ep.method || 'ANY').toUpperCase(),
        path: normalizeRoute(ep.path || ''),
      })),
    });
  }

  for (const [i, e] of (input.edges || []).entries()) {
    const where = `edges[${i}] (${e && e.source} -> ${e && e.target})`;
    if (!e || !e.source || !e.target) { errors.push(`${where}: source and target are required`); continue; }
    if (!ids.has(e.source)) errors.push(`${where}: unknown source node "${e.source}"`);
    if (!ids.has(e.target)) errors.push(`${where}: unknown target node "${e.target}"`);
    if (e.source === e.target) { warnings.push(`${where}: self-loop dropped`); continue; }
    const protocol = PROTOCOLS.includes(e.protocol) ? e.protocol : e.protocol ? 'other' : 'http';
    if (e.protocol && !PROTOCOLS.includes(e.protocol)) warnings.push(`${where}: unknown protocol "${e.protocol}", using "other"`);
    g.edges.push({
      ...e,
      protocol,
      async: Boolean(e.async),
      confidence: e.confidence === 'inferred' ? 'inferred' : 'high',
      calls: (Array.isArray(e.calls) ? e.calls : []).map((c) => ({
        ...c,
        method: String(c.method || (protocol === 'http' ? 'GET' : '')).toUpperCase(),
        path: normalizeRoute(c.path || ''),
        locations: Array.isArray(c.locations) ? c.locations : c.location ? [c.location] : [],
      })),
    });
  }

  for (const f of g.flows) {
    if (!f.id) errors.push('every flow needs an id');
    for (const step of f.steps || []) {
      const [s, t] = String(step).split('->').map((x) => x.trim());
      if (!g.edges.some((e) => e.source === s && e.target === t)) {
        warnings.push(`flow "${f.id}": step "${step}" does not match any edge`);
      }
    }
  }

  return { graph: g, errors, warnings };
}
