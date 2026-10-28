# Capturing traffic

Give the user the shortest path for what they already have. Everything here produces a file that `scripts/ingest.mjs` reads directly.

## Which source answers which question

| Source | Shows | Effort |
|---|---|---|
| HAR (browser) | every call the frontend makes: your APIs, CDNs, analytics, third parties; auth headers present or not | none — DevTools |
| Distributed traces (OpenTelemetry, Jaeger, Zipkin, vendors) | the full service-to-service tree: who called whom, DB/cache/queue calls, latency, errors | needs instrumentation (often already there) |

Code scan + HAR is the quickest way to confirm the frontend half; code scan + traces confirms the backend half.

## HAR from the browser

1. Open the app, open DevTools (F12) → **Network** tab. Tick **Preserve log**; optionally filter to **Fetch/XHR**.
2. Use the feature(s) to map: sign in, browse, add to cart, check out…
3. Right-click any request → **Save all as HAR** (Chrome/Edge: also the ⤓ download icon; Firefox: gear → Save All As HAR; Safari: Export).
4. `node ingest.mjs capture.har --client <frontend-node-id> -o har.events.jsonl`

Notes:
- Recent Chrome versions export a **sanitized** HAR by default (credentials stripped). That's fine for mapping; ingest notices and stops making auth judgements from it. For auth findings, enable *DevTools Settings → Preferences → Network → Allow to generate HAR with sensitive data* and choose "Export HAR (with sensitive data)". Ingest still never stores the values — only which kind of credential was present.
- Static assets (JS/CSS/images/fonts) and CORS preflights are skipped by default (`--include-assets`, `--include-preflight` to keep them).
- Mobile apps: capture through a proxy (Charles, Proxyman, mitmproxy, HTTP Toolkit) and export HAR from there.

## OpenTelemetry Collector (file export)

If services already send OTLP to a collector, add a file exporter alongside the existing one:

```yaml
exporters:
  file/traffic-lens:
    path: /tmp/traces.jsonl      # one OTLP JSON document per line
service:
  pipelines:
    traces:
      exporters: [otlp, file/traffic-lens]   # keep the existing exporter(s)
```

Run the system (or a test suite / load script) for a few minutes, then `node ingest.mjs /tmp/traces.jsonl -o otel.events.jsonl`.

No collector yet? The quickest local setup is the `otel/opentelemetry-collector-contrib` container with the config above plus an `otlp` receiver, and zero-code auto-instrumentation in each service (`@opentelemetry/auto-instrumentations-node`, `opentelemetry-instrument` for Python, the Java agent, .NET auto-instrumentation) pointed at it via `OTEL_EXPORTER_OTLP_ENDPOINT`. Each service needs a distinct `OTEL_SERVICE_NAME` — use the node ids from the code graph so they line up without aliases.

## Jaeger

- UI: open a trace → top-right **⋮ / Download JSON** (repeat for several traces, or):
- API: `curl "http://<jaeger>:16686/api/traces?service=<entry-service>&limit=500&lookback=1h" -o jaeger.json`
  Repeat per entry service if needed; ingest accepts a directory of files.

## Zipkin

`curl "http://<zipkin>:9411/api/v2/traces?serviceName=<svc>&limit=500" -o zipkin.json`

## Grafana Tempo / vendors

- **Tempo**: `curl "http://<tempo>/api/traces/<traceId>" -H 'Accept: application/json'` returns OTLP JSON; for many traces, search first (`/api/search?tags=service.name=<svc>`) and fetch each id.
- **Honeycomb, Datadog, New Relic, Dynatrace, Lightstep, AWS X-Ray, Azure Monitor**: most can export traces as OTLP JSON or JSON from their trace view/API; if a vendor only offers its own format, the easiest route is to tee an OTel Collector file exporter as above. X-Ray and vendor-native formats are not parsed directly.

## Size and privacy

- A few hundred traces or a few minutes of HAR is plenty — the map aggregates. Huge exports work but slow ingest.
- Ingest keeps: method, host, path (no query string), status, duration, timestamp, trace/span relationships, DB system/operation/table, queue topic, and which credential *type* was sent. It drops headers, cookies, bodies, SQL text and query strings. The generated HTML contains only aggregates.
