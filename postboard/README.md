# Postboard

A small post board split into a few services. Posts come from the public
[JSONPlaceholder](https://jsonplaceholder.typicode.com) API; because JSONPlaceholder never
persists writes, edits, pins, deletions and new posts are also kept in a local SQLite file.

No dependencies and no Docker — just Node 22.5+ (uses the built-in `node:sqlite`).

```
npm start            # all services; open http://localhost:3000
npm run start:fresh  # same, after wiping data/ and telemetry/
```

Sign in as any JSONPlaceholder user (e.g. `Bret`) with the password `demo`.

## Services

| Process | Port | What it does |
|---|---|---|
| `services/gateway` | 3000 | Serves the web app, routes `/auth/*` and `/api/*` |
| `services/auth` | 4001 | Login, token verification, user profiles |
| `services/posts-api` | 4002 | Posts CRUD over JSONPlaceholder + SQLite, publishes post events |
| `services/event-bus` | 4003 | In-memory message bus (stands in for RabbitMQ) |
| `services/indexer` | – | Consumes post events, writes JSON exports, calls a webhook |
| `web/` | – | Vanilla JS frontend |

Configuration for every process lives in `start.mjs`.

## Traffic data

Every service writes OpenTelemetry traces (OTLP JSON) to `telemetry/traces/<service>.jsonl`.

```
npm run simulate     # drive realistic traffic through the gateway (stack must be running)
npm run capture      # headless Chrome clicks through the UI → captures/session.har
npm run map          # rebuild the traffic-lens map from .traffic-lens/code-graph.json + traffic
npm run live         # live map on http://localhost:4317 — updates while you click around
npm run baseline     # save the current map as a baseline …
npm run diff         # … then, after changing code and re-mapping, see what changed
```

You can also capture a HAR by hand: DevTools → Network → use the app → right-click → *Save all as HAR* → put it in `captures/`.
