#!/usr/bin/env node
// Live mode: serve the map on localhost and rebuild it whenever traffic files (or the code
// graph) change. Open pages update in place and briefly pulse the connections that got
// new requests.
//
//   node serve.mjs --graph .traffic-lens/code-graph.json --watch telemetry/traces --watch captures \
//                  [--client web] [--port 4317] [--title T] [--open]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readText } from './lib/util.mjs';
import { buildGraph, openInBrowser } from './lib/pipeline.mjs';
import { ingestFiles, expandFiles } from './lib/ingestion.mjs';
import { renderHtml } from './lib/render.mjs';

function parseArgs(argv) {
  const o = { watch: [], port: 4317, client: 'browser', open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--graph') o.graph = next();
    else if (a === '--watch') o.watch.push(next());
    else if (a === '--client') o.client = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--title') o.title = next();
    else if (a === '--error-rate') o.errorRate = Number(next());
    else if (a === '--slow-ms') o.slowMs = Number(next());
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || (!opts.graph && !opts.watch.length)) {
  console.log('usage: node serve.mjs --graph code-graph.json --watch <dir|file> [--watch ...] [--client web] [--port 4317] [--open]');
  process.exit(opts.help ? 0 : 1);
}

let current = null;
let lastFingerprint = '';
const clients = new Set();

// size + mtime of everything we depend on; cheap to poll and works on every OS
function fingerprint() {
  const files = [...(opts.graph ? [opts.graph] : []), ...expandFiles(opts.watch.filter((w) => fs.existsSync(w)))];
  return files.map((f) => {
    try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:missing`; }
  }).join('|');
}

function rebuild(reason) {
  const started = Date.now();
  let input = { nodes: [], edges: [] };
  if (opts.graph) {
    try {
      input = JSON.parse(readText(opts.graph));
    } catch (err) {
      console.error(`✗ ${opts.graph}: ${err.message} (keeping the previous map)`);
      return;
    }
  }
  const watched = opts.watch.filter((w) => fs.existsSync(w));
  const { events, log } = watched.length ? ingestFiles(watched, { client: opts.client }) : { events: [], log: [] };
  for (const l of log.filter((x) => x.startsWith('✗'))) console.error(l);
  const { graph, errors } = buildGraph(input, events, { ...opts, live: true });
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    return;
  }
  current = graph;
  const payload = `event: graph\ndata: ${JSON.stringify(graph)}\n\n`;
  for (const res of clients) res.write(payload);
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${reason}: ${graph.nodes.length} nodes · ${graph.edges.length} connections · ` +
    `${graph.meta.requests} requests · ${graph.findings.length} findings (${Date.now() - started} ms, ${clients.size} viewer${clients.size === 1 ? '' : 's'})`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/graph.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(current));
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderHtml(current));
  }
  res.writeHead(404).end();
});

rebuild('initial build');
lastFingerprint = fingerprint();
setInterval(() => {
  const fp = fingerprint();
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  rebuild('change detected');
}, 1000);
// keep idle connections alive through proxies
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

server.listen(opts.port, () => {
  const url = `http://localhost:${opts.port}`;
  console.log(`\nlive map → ${url}  (watching ${[opts.graph, ...opts.watch].filter(Boolean).map((p) => path.normalize(p)).join(', ')})\n`);
  if (opts.open) openInBrowser(url);
});
