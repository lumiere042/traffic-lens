// Markdown reports: one for a single map (findings summary), one for a diff (PR comment).

const SEV = ['high', 'medium', 'low', 'info'];
const ICON = { high: '🔴', medium: '🟠', low: '🔵', info: '⚪' };
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pct = (r) => `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;
const ms = (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function findingLines(findings, { max = 25, withItems = 3 } = {}) {
  const lines = [];
  for (const f of findings.slice(0, max)) {
    lines.push(`- ${ICON[f.severity] || ''} **${esc(f.title)}** — _${f.category}_`);
    for (const it of (f.items || []).slice(0, withItems)) lines.push(`  - \`${esc(it)}\``);
    if ((f.items || []).length > withItems) lines.push(`  - …and ${f.items.length - withItems} more`);
  }
  if (findings.length > max) lines.push(`- …and ${findings.length - max} more`);
  return lines;
}

export function graphReport(graph, { mapPath } = {}) {
  const by = (s) => graph.findings.filter((f) => f.severity === s);
  const m = graph.meta || {};
  const lines = [
    `## Traffic map: ${esc(graph.title)}`,
    '',
    `${count(graph.nodes.length, 'node')} · ${count(graph.edges.length, 'connection')} · ${count(graph.flows.length, 'flow')}` +
      (m.requests ? ` · ${m.requests} requests (${pct(m.errors / m.requests)} errors)` : '') +
      (m.sources?.length ? ` · sources: ${m.sources.join(', ')}` : ''),
    '',
    `**Findings:** ${SEV.map((s) => `${ICON[s]} ${by(s).length} ${s}`).join(' · ')}`,
    '',
  ];
  const important = graph.findings.filter((f) => f.severity !== 'info');
  if (important.length) lines.push(...findingLines(important), '');
  const inferred = graph.edges.filter((e) => e.confidence === 'inferred');
  if (inferred.length) {
    lines.push('<details><summary>Inferred connections (unverified)</summary>', '');
    for (const e of inferred) lines.push(`- ${esc(e.source)} → ${esc(e.target)}${e.description ? ` — ${esc(e.description)}` : ''}`);
    lines.push('', '</details>', '');
  }
  if (mapPath) lines.push(`Interactive map: \`${mapPath}\``);
  return lines.join('\n') + '\n';
}

export function diffReport({ changes, summary, union }, { mapPath } = {}) {
  const d = union.meta.diff;
  const lines = [`## Traffic map changes: ${esc(d.base.label)} → ${esc(d.head.label)}`, ''];
  if (!summary.total) {
    lines.push('No changes to connections, routes, health or findings.');
    return lines.join('\n') + '\n';
  }
  const bits = [];
  if (summary.edgesAdded) bits.push(`➕ ${count(summary.edgesAdded, 'new connection')}`);
  if (summary.edgesRemoved) bits.push(`➖ ${count(summary.edgesRemoved, 'removed connection')}`);
  if (summary.edgesChanged) bits.push(`✏️ ${count(summary.edgesChanged, 'connection')} with route changes`);
  if (summary.regressions) bits.push(`📉 ${count(summary.regressions, 'regression')}`);
  if (summary.improvements) bits.push(`📈 ${count(summary.improvements, 'improvement')}`);
  if (summary.findingsNew) bits.push(`🆕 ${count(summary.findingsNew, 'new finding')}`);
  if (summary.findingsResolved) bits.push(`✅ ${count(summary.findingsResolved, 'resolved finding')}`);
  if (summary.findingsChanged) bits.push(`🔁 ${count(summary.findingsChanged, 'changed finding')}`);
  lines.push(bits.join(' · '), '');

  const severe = changes.findings.new.filter((f) => f.severity === 'high');
  if (severe.length) lines.push(`> [!WARNING]\n> This change introduces ${count(severe.length, 'high-severity finding')}.`, '');

  if (changes.nodes.added.length || changes.nodes.removed.length) {
    lines.push('### Services', '');
    for (const n of changes.nodes.added) lines.push(`- ➕ **${esc(n.label)}** (${n.kind})`);
    for (const n of changes.nodes.removed) lines.push(`- ➖ ~~${esc(n.label)}~~ (${n.kind})`);
    lines.push('');
  }
  if (changes.edges.added.length || changes.edges.removed.length || changes.routes.length) {
    lines.push('### Connections', '', '| | Connection | Routes |', '|---|---|---|');
    for (const e of changes.edges.added) lines.push(`| ➕ | ${esc(e.label)} | ${e.routes.map((r) => `\`${esc(r)}\``).join('<br>')} |`);
    for (const e of changes.edges.removed) lines.push(`| ➖ | ${esc(e.label)} | ${e.routes.map((r) => `~~\`${esc(r)}\`~~`).join('<br>')} |`);
    for (const r of changes.routes) {
      const cells = [...r.added.map((x) => `➕ \`${esc(x)}\``), ...r.removed.map((x) => `➖ ~~\`${esc(x)}\`~~`)];
      lines.push(`| ✏️ | ${esc(r.label)} | ${cells.join('<br>')} |`);
    }
    lines.push('');
  }
  if (changes.health.length) {
    lines.push('### Health', '', '| | Connection | Route | Before | After |', '|---|---|---|---|---|');
    for (const h of changes.health) {
      const fmt = h.kind === 'errors' ? pct : ms;
      lines.push(`| ${h.direction === 'worse' ? '📉' : '📈'} ${h.kind} | ${esc(h.label)} | \`${esc(h.route)}\` | ${fmt(h.from)} | ${fmt(h.to)} |`);
    }
    lines.push('');
  }
  if (changes.findings.new.length) lines.push('### New findings', '', ...findingLines(changes.findings.new, { withItems: 2 }), '');
  if (changes.findings.resolved.length) {
    lines.push('### Resolved findings', '');
    for (const f of changes.findings.resolved) lines.push(`- ✅ ~~${esc(f.title)}~~ — _${f.category}_`);
    lines.push('');
  }
  if (changes.findings.changed.length) {
    lines.push('### Changed findings', '');
    for (const f of changes.findings.changed) {
      lines.push(`- 🔁 **${esc(f.title)}** — _${f.category}_`);
      for (const it of f.itemsRemoved) lines.push(`  - ✅ ~~\`${esc(it)}\`~~`);
      for (const it of f.itemsAdded) lines.push(`  - ➕ \`${esc(it)}\``);
    }
    lines.push('');
  }
  if (mapPath) lines.push(`Interactive diff map: \`${mapPath}\``);
  return lines.join('\n') + '\n';
}
