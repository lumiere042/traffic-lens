import fs from 'node:fs';

export const KINDS = [
  'client', 'gateway', 'auth', 'service', 'function', 'worker',
  'queue', 'cache', 'database', 'search', 'storage', 'external',
];

export const PROTOCOLS = [
  'http', 'graphql', 'grpc', 'websocket', 'sse', 'sql', 'nosql', 'redis',
  'queue', 'kafka', 'amqp', 'sqs', 'pubsub', 's3', 'smtp', 'tcp', 'other',
];

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Endpoint/call auth values that mean "no credential is required/sent".
export const NO_AUTH = new Set(['none', 'public', 'anonymous']);

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node';
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

// Parse a JSON file, or a JSON-lines file where each line is a JSON document.
export function readJsonOrLines(file) {
  const text = readText(file).trim();
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    const docs = [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    lines.forEach((t, i) => {
      try {
        docs.push(JSON.parse(t));
      } catch (err) {
        // a file that is still being appended to can end in a half-written line
        if (i !== lines.length - 1) throw err;
      }
    });
    return { kind: 'lines', value: docs };
  }
}

export function readEvents(file) {
  const out = [];
  for (const line of readText(file).split(/\r?\n/)) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t));
  }
  return out;
}

export function isLocalHost(host) {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.svc') || h.includes('.svc.cluster.')
  );
}

export function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
