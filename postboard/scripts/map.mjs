#!/usr/bin/env node
// Shortcuts for iterating on the traffic-lens skill. The code graph itself comes from running
// the skill ("map the traffic in this repo") → .traffic-lens/code-graph.json.
//
//   node scripts/map.mjs [--open]      ingest captures/*.har + telemetry/traces, rebuild the map
//   node scripts/map.mjs --live        live map on http://localhost:4317 (updates as traffic arrives)
//   node scripts/map.mjs --baseline    rebuild, then save the result as the diff baseline
//   node scripts/map.mjs --diff        rebuild, then diff against the saved baseline

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const TL = process.env.TRAFFIC_LENS || path.join(os.homedir(), '.claude', 'skills', 'traffic-lens');
const work = '.traffic-lens';
const graph = path.join(work, 'code-graph.json');
const baseline = path.join(work, 'baseline');
const client = process.env.HAR_CLIENT || 'web';
const flag = (f) => process.argv.includes(f);
const script = (name) => path.join(TL, 'scripts', name);
const run = (name, args) => execFileSync(process.execPath, [script(name), ...args], { stdio: 'inherit' });

if (!fs.existsSync(script('build.mjs'))) {
  console.error(`traffic-lens skill not found at ${TL} (set TRAFFIC_LENS)`);
  process.exit(1);
}
fs.mkdirSync(work, { recursive: true });

if (flag('--live')) {
  const args = [script('serve.mjs'), '--watch', 'telemetry/traces', '--watch', 'captures', '--client', client, '--open'];
  if (fs.existsSync(graph)) args.push('--graph', graph);
  spawn(process.execPath, args, { stdio: 'inherit' });
} else {
  const events = [];
  const hars = fs.existsSync('captures') ? fs.readdirSync('captures').filter((f) => f.endsWith('.har')).map((f) => path.join('captures', f)) : [];
  if (hars.length) {
    run('ingest.mjs', [...hars, '--client', client, '-o', path.join(work, 'har.events.jsonl')]);
    events.push('--events', path.join(work, 'har.events.jsonl'));
  }
  if (fs.existsSync('telemetry/traces') && fs.readdirSync('telemetry/traces').length) {
    run('ingest.mjs', ['telemetry/traces', '-o', path.join(work, 'otel.events.jsonl')]);
    events.push('--events', path.join(work, 'otel.events.jsonl'));
  }
  if (!fs.existsSync(graph)) console.log('no .traffic-lens/code-graph.json yet — building from traffic only');
  run('build.mjs', [...(fs.existsSync(graph) ? ['--graph', graph] : ['--title', 'Postboard (traffic only)']), ...events,
    '--out', path.join(work, 'traffic-map.html'), ...(flag('--open') ? ['--open'] : [])]);

  if (flag('--baseline')) {
    fs.mkdirSync(baseline, { recursive: true });
    fs.copyFileSync(path.join(work, 'traffic-map.graph.json'), path.join(baseline, 'traffic-map.graph.json'));
    if (fs.existsSync(graph)) fs.copyFileSync(graph, path.join(baseline, 'code-graph.json'));
    console.log(`\nbaseline saved to ${baseline}/ — change the code, re-map, then run: npm run diff`);
  }
  if (flag('--diff')) {
    if (!fs.existsSync(path.join(baseline, 'traffic-map.graph.json'))) {
      console.error('no baseline yet — run: npm run baseline');
      process.exit(1);
    }
    run('diff.mjs', ['--base', path.join(baseline, 'traffic-map.graph.json'), '--head', path.join(work, 'traffic-map.graph.json'),
      '--base-label', 'baseline', '--head-label', 'now', '--out', path.join(work, 'diff.html'), '--md', path.join(work, 'diff.md'), '--open']);
  }
}
