// Read traffic files (HAR, OTLP / Jaeger / Zipkin traces) into sanitized events.
// Shared by ingest.mjs (CLI) and serve.mjs (live mode).

import fs from 'node:fs';
import path from 'node:path';
import { readJsonOrLines } from './util.mjs';
import { isHar, harToEvents } from './har.mjs';
import { detectTraceFormat, tracesToEvents } from './otel.mjs';

export const TRAFFIC_FILE = /\.(har|json|jsonl|ndjson)$/i;

export function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
      for (const name of fs.readdirSync(f)) if (TRAFFIC_FILE.test(name)) out.push(path.join(f, name));
    } else out.push(f);
  }
  return out;
}

// opts: { client, includeAssets, includePreflight }. Returns { events, log, failed }.
export function ingestFiles(files, opts = {}) {
  const events = [];
  const log = [];
  const traceDocs = { otlp: [], jaeger: [], zipkin: [] };
  const traceFiles = { otlp: [], jaeger: [], zipkin: [] };
  let failed = false;

  for (const file of expandFiles(files)) {
    let parsed;
    try {
      parsed = readJsonOrLines(file);
    } catch (err) {
      // a trace file being appended to can end in a partial line; skip it this round
      log.push(`✗ ${file}: not JSON / JSON-lines (${err.message})`);
      failed = true;
      continue;
    }
    const docs = parsed.kind === 'lines' ? parsed.value : [parsed.value];

    if (docs.length === 1 && isHar(docs[0])) {
      const { events: evs, stats } = harToEvents(docs[0], opts);
      events.push(...evs);
      log.push(`✓ ${file}: HAR · ${stats.entries} entries → ${stats.kept} API requests` +
        ` (skipped ${stats.assets} static assets, ${stats.preflight} CORS preflights, ${stats.invalid} non-http)`);
      if (stats.sanitizedLikely) {
        log.push('  ! no request carried credentials — the HAR was probably exported "sanitized";' +
          ' auth is recorded as unknown so no auth findings are produced from it');
      }
      continue;
    }

    const format = detectTraceFormat(parsed.kind === 'lines' ? docs : docs[0]);
    if (format) {
      // Collected across files and converted together below: exporters often write one
      // file per service, and a span's parent is usually in another service's file.
      traceDocs[format].push(...(format === 'zipkin' ? docs : docs.flatMap((d) => (Array.isArray(d) ? d : [d]))));
      traceFiles[format].push(file);
      continue;
    }

    log.push(`✗ ${file}: unrecognized format (expected HAR, OTLP JSON, Jaeger JSON or Zipkin v2 JSON)`);
    failed = true;
  }

  for (const format of Object.keys(traceDocs)) {
    if (!traceDocs[format].length) continue;
    const { events: evs, stats } = tracesToEvents(traceDocs[format], format);
    events.push(...evs);
    const fs_ = traceFiles[format];
    log.push(`✓ ${fs_.length === 1 ? fs_[0] : `${fs_.length} files`}: ${format.toUpperCase()} traces · ` +
      `${stats.traces} traces, ${stats.spans} spans → ${evs.length} cross-service calls`);
    log.push(`  services: ${stats.services.join(', ')}`);
  }
  return { events, log, failed };
}
