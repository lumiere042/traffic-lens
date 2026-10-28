#!/usr/bin/env node
// Convert captured traffic (HAR, OTLP/Jaeger/Zipkin traces) into sanitized events.
//
//   node ingest.mjs <file>... [-o events.jsonl] [--client <node-id>] [--include-assets]
//
// Output is JSON lines, one request/span per line, in the shape build.mjs expects.

import fs from 'node:fs';
import path from 'node:path';
import { ingestFiles } from './lib/ingestion.mjs';

function parseArgs(argv) {
  const opts = { files: [], out: 'events.jsonl', client: 'browser', includeAssets: false, includePreflight: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--client') opts.client = argv[++i];
    else if (a === '--include-assets') opts.includeAssets = true;
    else if (a === '--include-preflight') opts.includePreflight = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.files.length) {
  console.log('usage: node ingest.mjs <file|dir>... [-o events.jsonl] [--client <node-id>] [--include-assets] [--include-preflight]');
  process.exit(opts.help ? 0 : 1);
}

const { events: all, log, failed } = ingestFiles(opts.files, opts);
for (const line of log) (line.startsWith('✗') ? console.error : console.log)(line);

fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
fs.writeFileSync(opts.out, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''));
const pairs = new Set(all.map((e) => `${e.source} → ${e.target}`));
console.log(`\nwrote ${all.length} events (${pairs.size} distinct source → target pairs) to ${opts.out}`);
for (const p of [...pairs].slice(0, 40)) console.log('  ' + p);
if (pairs.size > 40) console.log(`  … ${pairs.size - 40} more`);
process.exit(failed && !all.length ? 1 : 0);
