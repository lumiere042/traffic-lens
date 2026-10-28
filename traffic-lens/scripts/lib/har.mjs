// HAR (browser DevTools export) -> traffic events.
//
// Privacy: only the method, host, path (no query string), status, timing, and the
// *kind* of credential sent (never its value) are kept. Bodies are not read, except
// for a GraphQL request's operation name.

import { stripQuery, templatePath } from './paths.mjs';
import { isLocalHost } from './util.mjs';

const API_TYPES = new Set(['xhr', 'fetch', 'websocket', 'eventsource', 'ping', 'preflight']);
const ASSET_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|html?|txt|wasm)$/i;
const API_MIME = /(json|graphql|grpc|protobuf|event-stream|x-www-form-urlencoded|msgpack|xml)/i;

export function isHar(doc) {
  return doc && typeof doc === 'object' && doc.log && Array.isArray(doc.log.entries);
}

export function harToEvents(doc, opts = {}) {
  const client = opts.client || 'browser';
  const events = [];
  const stats = { entries: 0, kept: 0, assets: 0, preflight: 0, invalid: 0, withAuthHeaders: 0 };

  for (const e of doc.log.entries) {
    stats.entries++;
    let url;
    try { url = new URL(e.request.url); } catch { stats.invalid++; continue; }
    if (!/^(https?|wss?):$/.test(url.protocol)) { stats.invalid++; continue; }

    const method = String(e.request.method || 'GET').toUpperCase();
    if (method === 'OPTIONS' && !opts.includePreflight) { stats.preflight++; continue; }

    const type = (e._resourceType || '').toLowerCase();
    const mime = (e.response && e.response.content && e.response.content.mimeType) || '';
    const isWs = type === 'websocket' || /^wss?:$/.test(url.protocol);
    const looksApi = type
      ? API_TYPES.has(type)
      : (method !== 'GET' || API_MIME.test(mime) || /\/(api|graphql|rpc|v\d+)\b/i.test(url.pathname)) && !ASSET_EXT.test(url.pathname);
    if (!looksApi && !isWs && !opts.includeAssets) { stats.assets++; continue; }

    const headers = Object.fromEntries((e.request.headers || []).map((h) => [String(h.name).toLowerCase(), String(h.value || '')]));
    const auth = detectAuth(headers, e.request.cookies);
    if (auth !== 'none') stats.withAuthHeaders++;

    const path = stripQuery(url.pathname) || '/';
    let operation = null;
    let protocol = isWs ? 'websocket' : /event-stream/i.test(mime) ? 'sse' : 'http';
    if (/graphql/i.test(path)) {
      protocol = 'graphql';
      operation = graphqlOperation(e.request.postData && e.request.postData.text, url.searchParams);
    }

    const status = Number(e.response && e.response.status) || 0;
    const scheme = url.protocol.replace(':', '');
    events.push({
      origin: 'har',
      source: client,
      target: url.host,
      target_kind: null,
      protocol,
      async: false,
      method: isWs ? 'WS' : method,
      path,
      route: templatePath(path),
      operation,
      status,
      error: status === 0 || status >= 500,
      duration_ms: typeof e.time === 'number' && e.time >= 0 ? Math.round(e.time * 10) / 10 : null,
      ts: e.startedDateTime || null,
      trace_id: null,
      root: true,
      auth,
      insecure: (scheme === 'http' || scheme === 'ws') && !isLocalHost(url.hostname),
    });
    stats.kept++;
  }

  // Chrome and Firefox can export "sanitized" HARs with credentials removed. If no
  // request carries any credential we cannot tell "unauthenticated" from "stripped",
  // so mark auth as unknown rather than producing false security findings.
  stats.sanitizedLikely = stats.kept > 0 && stats.withAuthHeaders === 0;
  if (stats.sanitizedLikely) for (const ev of events) ev.auth = null;

  return { events, stats };
}

function detectAuth(headers, cookies) {
  const a = headers['authorization'] || '';
  if (/^bearer\s/i.test(a)) return 'bearer';
  if (/^basic\s/i.test(a)) return 'basic';
  if (a) return 'token';
  if (Object.keys(headers).some((h) => /^(x-)?api[-_]?key$|^x-auth-token$|^x-access-token$/.test(h))) return 'apikey';
  if (headers['cookie'] || (cookies && cookies.length)) return 'cookie';
  return 'none';
}

function graphqlOperation(body, params) {
  const fromQuery = params && (params.get('operationName') || null);
  if (fromQuery) return fromQuery;
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && first.operationName) return String(first.operationName);
    const m = first && typeof first.query === 'string' && first.query.match(/^\s*(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
    if (m) return m[2];
  } catch { /* not JSON */ }
  return null;
}
