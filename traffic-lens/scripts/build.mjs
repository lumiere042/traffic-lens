#!/usr/bin/env node
// Build the traffic map: validate the code graph, merge captured traffic, run the
// security / contract / health / structure checks, and render the HTML viewer.
//
//   node build.mjs --graph code-graph.json [--events events.jsonl ...] \
//                  [--out traffic-map.html] [--json-out traffic-map.graph.json] [--md report.md] [--open]

import fs from 'node:fs';
import path from 'node:path';
import { readText, readEvents, fmtCount } from './lib/util.mjs';
import { buildGraph, openInBrowser } from './lib/pipeline.mjs';
import { renderHtml } from './lib/render.mjs';
import { graphReport } from './lib/report.mjs';

function parseArgs(argv) {
  const o = { events: [], out: 'traffic-map.html', open: false, errorRate: 0.05, slowMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--graph') o.graph = next();
    else if (a === '--events') o.events.push(next());
    else if (a === '--out') o.out = next();
    else if (a === '--json-out') o.jsonOut = next();
    else if (a === '--md') o.md = next();
    else if (a === '--title') o.title = next();
    else if (a === '--subtitle') o.subtitle = next();
    else if (a === '--error-rate') o.errorRate = Number(next());
    else if (a === '--slow-ms') o.slowMs = Number(next());
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || (!opts.graph && !opts.events.length)) {
  console.log('usage: node build.mjs --graph code-graph.json [--events events.jsonl ...] [--out traffic-map.html]\n' +
    '                      [--json-out traffic-map.graph.json] [--md report.md] [--title T] [--subtitle S]\n' +
    '                      [--error-rate 0.05] [--slow-ms 1000] [--open]');
  process.exit(opts.help ? 0 : 1);
}

let input = { nodes: [], edges: [] };
if (opts.graph) {
  try {
    input = JSON.parse(readText(opts.graph));
  } catch (err) {
    console.error(`✗ ${opts.graph} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}
const events = opts.events.flatMap((f) => readEvents(f));
const { graph, errors, warnings, created, selfCalls } = buildGraph(input, events, opts);
for (const w of warnings) console.log(`  ! ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} error(s) in ${opts.graph}; fix them and re-run.`);
  process.exit(1);
}
if (selfCalls) console.log(`  · ${selfCalls} same-node request(s) skipped (a node calling itself)`);

// ---------- write ----------
const out = path.resolve(opts.out);
const jsonOut = path.resolve(opts.jsonOut || out.replace(/\.html?$/i, '') + '.graph.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(jsonOut, JSON.stringify(graph, null, 2));
fs.writeFileSync(out, renderHtml(graph));
if (opts.md) fs.writeFileSync(opts.md, graphReport(graph, { mapPath: path.relative(path.dirname(path.resolve(opts.md)), out) }));

// ---------- summary ----------
const { requests, errors: reqErrors, sources } = graph.meta;
const bySev = (s) => graph.findings.filter((f) => f.severity === s).length;
console.log(`\n✓ ${graph.title}: ${graph.nodes.length} nodes · ${graph.edges.length} connections · ${graph.flows.length} flows` +
  (requests ? ` · ${fmtCount(requests)} requests (${fmtCount(reqErrors)} errors)` : ''));
console.log(`  sources: ${sources.join(', ') || 'none'}`);
if (created.length) {
  console.log(`  nodes discovered only in traffic (add aliases in the code graph if these are known services):`);
  for (const n of created) console.log(`    - ${n.id}  (${n.kind}, from "${n.aliases[0]}")`);
}
const obs = { both: 0, code: 0, traffic: 0 };
for (const e of graph.edges) obs[e.observed || 'code']++;
if (events.length) console.log(`  connections: ${obs.both} confirmed by traffic · ${obs.code} code-only · ${obs.traffic} traffic-only`);
console.log(`  findings: ${bySev('high')} high · ${bySev('medium')} medium · ${bySev('low')} low · ${bySev('info')} info`);
for (const f of graph.findings.filter((f) => f.severity !== 'info').slice(0, 15)) {
  console.log(`    [${f.severity}] ${f.category}: ${f.title}`);
}
console.log(`\n  map:   ${out}\n  graph: ${jsonOut}${opts.md ? `\n  report: ${path.resolve(opts.md)}` : ''}`);
if (opts.open) openInBrowser(out);
