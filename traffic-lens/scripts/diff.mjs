#!/usr/bin/env node
// Compare two maps and report what changed: connections, routes, health, findings.
//
//   node diff.mjs --base main.graph.json --head pr.graph.json \
//                 [--out diff.html] [--md diff.md] [--base-label main] [--head-label "PR #12"] \
//                 [--fail-on high|medium] [--open]
//
// Inputs are either built maps (*.graph.json from build.mjs) or raw code graphs
// (code-graph.json), which are built on the fly without traffic.

import fs from 'node:fs';
import path from 'node:path';
import { readText } from './lib/util.mjs';
import { buildGraph, openInBrowser } from './lib/pipeline.mjs';
import { diffGraphs } from './lib/diff.mjs';
import { analyze } from './lib/analyze.mjs';
import { diffReport } from './lib/report.mjs';
import { renderHtml } from './lib/render.mjs';

function parseArgs(argv) {
  const o = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') o.base = next();
    else if (a === '--head') o.head = next();
    else if (a === '--out') o.out = next();
    else if (a === '--md') o.md = next();
    else if (a === '--base-label') o.baseLabel = next();
    else if (a === '--head-label') o.headLabel = next();
    else if (a === '--fail-on') o.failOn = next();
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  return o;
}

function load(file) {
  let json;
  try {
    json = JSON.parse(readText(file));
  } catch (err) {
    console.error(`✗ ${file}: ${err.message}`);
    process.exit(1);
  }
  const built = Array.isArray(json.findings) && (json.edges || []).every((e) => e.id);
  if (built) {
    // re-run the current analysis so both sides are judged by the same rules, even when one
    // map was built by an older version of this skill
    const sources = json.meta?.sources || [];
    json.findings = analyze(json, {
      hasTraffic: sources.includes('har') || sources.includes('otel'),
      hadCodeEdges: json.edges.some((e) => e.observed !== 'traffic'),
      errorRate: json.meta?.thresholds?.errorRate,
      slowMs: json.meta?.thresholds?.slowMs,
    });
    return json;
  }
  const { graph, errors } = buildGraph(json, []);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${file}: ${e}`);
    process.exit(1);
  }
  return graph;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.base || !opts.head) {
  console.log('usage: node diff.mjs --base base.graph.json --head head.graph.json [--out diff.html] [--md diff.md]\n' +
    '                     [--base-label main] [--head-label PR] [--fail-on high|medium] [--open]');
  process.exit(opts.help ? 0 : 1);
}

const result = diffGraphs(load(opts.base), load(opts.head), {
  baseLabel: opts.baseLabel || path.basename(opts.base),
  headLabel: opts.headLabel || path.basename(opts.head),
});
const { summary, changes } = result;

if (opts.out) {
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, renderHtml(result.union));
}
const md = diffReport(result, { mapPath: opts.out ? path.basename(opts.out) : undefined });
if (opts.md) fs.writeFileSync(opts.md, md);

console.log(summary.total ? `✓ ${summary.total} change(s):` : '✓ no changes');
const line = (n, s) => n && console.log(`  ${s}`);
line(summary.edgesAdded, `+ ${summary.edgesAdded} connection(s): ${changes.edges.added.map((e) => e.label).join(', ')}`);
line(summary.edgesRemoved, `- ${summary.edgesRemoved} connection(s): ${changes.edges.removed.map((e) => e.label).join(', ')}`);
line(summary.edgesChanged, `~ ${summary.edgesChanged} connection(s) with route changes`);
line(summary.regressions, `▼ ${summary.regressions} health regression(s)`);
line(summary.improvements, `▲ ${summary.improvements} health improvement(s)`);
line(summary.findingsNew, `! ${summary.findingsNew} new finding(s): ${changes.findings.new.map((f) => `[${f.severity}] ${f.title}`).join('; ')}`);
line(summary.findingsResolved, `✓ ${summary.findingsResolved} resolved finding(s): ${changes.findings.resolved.map((f) => f.title).join('; ')}`);
line(summary.findingsChanged, `↻ ${summary.findingsChanged} changed finding(s): ${changes.findings.changed.map((f) => `${f.title} (+${f.itemsAdded.length}/−${f.itemsRemoved.length})`).join('; ')}`);
if (opts.out) console.log(`\n  diff map: ${path.resolve(opts.out)}`);
if (opts.md) console.log(`  report:   ${path.resolve(opts.md)}`);
else console.log('\n' + md);
if (opts.open && opts.out) openInBrowser(path.resolve(opts.out));

// CI gate: fail when the change introduces findings at or above the given severity
if (opts.failOn) {
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  const bad = changes.findings.new.filter((f) => rank[f.severity] <= (rank[opts.failOn] ?? 0));
  if (bad.length) {
    console.error(`\n✗ ${bad.length} new finding(s) at or above "${opts.failOn}"`);
    process.exit(2);
  }
}
