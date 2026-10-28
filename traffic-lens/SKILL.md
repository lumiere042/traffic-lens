---
name: traffic-lens
description: Map and visualize API traffic inside a software system — which clients, services, workers, databases, queues and third-party APIs call what, over which routes — as a sleek interactive diagram (single HTML file) with request-flow tracing, live-traffic overlays and security/contract findings. Use this skill whenever the user wants to see or understand service-to-service communication, API dependencies, "what talks to what", request paths through a system, microservice call graphs, or endpoint usage; when they share a HAR file, OpenTelemetry/Jaeger/Zipkin traces and want them visualized; or when they ask which endpoints are unused, unauthenticated, broken or undocumented. Trigger even if they don't say "diagram" or "traffic" — e.g. "how do our services connect?", "map the calls in this repo", "what hits the orders API?", "visualize this .har".
---

# Traffic Lens

Produce an interactive traffic map: nodes are deployable things (apps, services, workers, functions, data stores, queues, third parties), lines are the calls between them, and each line carries the concrete routes (`POST /checkout`, `SELECT orders`, `publish order.created`) with the source location that makes the call.

The work splits cleanly in two:

- **You** do what needs judgement: read the system and write a *code graph* (JSON) describing nodes, routes served, calls made, and key request flows.
- **Bundled scripts** do everything deterministic: parse captured traffic, merge it with your graph, compute stats and findings, and render the viewer. This keeps every map consistent and lets real traffic confirm or contradict what the code says.

Scripts need Node 18+ and have no dependencies. In the commands below `$TL` is this skill's directory (the folder containing this file).

## Workflow

### 1. Scope the job

Work out from the request and the working directory:
- **What to scan** — the current repo by default; several folders/repos if the user names them (or if a monorepo/compose file points at sibling repos).
- **What traffic exists** — any `.har`, trace exports (`*.json`, `*.jsonl` from Jaeger/Zipkin/OTel collector) the user mentions or that sit in the project. Traffic is optional; a code-only map is useful on its own.

Don't interrogate the user. If nothing is specified, scan the working directory and mention at the end that a HAR capture or trace export can be layered on (see `references/capturing-traffic.md` for how they'd get one).

Put working files in `.traffic-lens/` at the root of the (primary) scanned project: `code-graph.json`, `*.events.jsonl`, and the output `traffic-map.html`. Suggest adding `.traffic-lens/` to `.gitignore` if it isn't already ignored.

### 2. Scan the code → `code-graph.json`

Read `references/code-scan.md` before scanning — it lists what to look for per language/framework and how to resolve where a URL actually points. Read `references/graph-schema.md` for the exact JSON format.

The shape of a good scan:

1. **Inventory deployables first.** Look at workspace/package manifests, `docker-compose*.yml`, Kubernetes/Helm manifests, `Procfile`, serverless configs, Dockerfiles, and top-level app folders. Each independently deployed process is a node. Modules, classes and libraries are *not* nodes — a map of 200 boxes is unreadable. Data stores, queues/topics, object storage and third-party APIs are nodes too.
2. **For each service, find what it serves** (its routes → `endpoints`, with the auth each requires) **and what it calls** (HTTP clients, SDKs, DB/cache clients, producers/consumers → `edges` with `calls`).
3. **Resolve targets.** A call to `${ORDERS_URL}/orders` is only useful once you know `ORDERS_URL` means the orders service. Follow env files, compose `environment:`, k8s ConfigMaps, config modules and client factories (`axios.create({ baseURL })`). Compose/k8s service names double as hostnames, which is how separate repos get stitched together.
4. **Cite evidence.** Every call gets `locations: ["path/file.ts:42"]`. When you could not resolve a target with confidence, still draw the edge but set `"confidence": "inferred"` and say why in `description` — never invent a connection with no evidence.
5. **Add `aliases`** to nodes: hostnames, `host:port`, OTel `service.name`, compose service names. Traffic is matched to nodes through these, so this is what makes step 3 line up.
6. **Write 2–6 `flows`** for the journeys that matter (checkout, login, upload, nightly job): start at the entry route, follow the handler code, and list the hops as `"source->target"` edge references in order.
7. **Run the risk checklist** (`references/code-scan.md` §9) on every service before you write the graph. It covers:
   - auth on admin/sensitive routes and on *every* method, including `PATCH`;
   - call sites that skip the authenticated helper;
   - clients calling internal services directly;
   - `http://` literals and wildcard CORS;
   - calls whose method/path the target doesn't serve, and routes nobody calls;
   - file-system and webhook side effects;
   - missing timeouts, calls inside loops (`loop`), and back-calls that form cycles.

   These are what turn the map from a picture into findings. Record what the code actually does, even when it is obviously a mistake; the mismatch is the point.

Scale the effort to the system: a single repo can be read directly with Grep/Glob/Read. For many repos or a large monorepo, and if you can spawn subagents, scan each repo/service in parallel with the same instructions and merge the partial graphs yourself (dedupe nodes by id; reconcile aliases).

Prefer grouping over omission: put data stores in a `"Data tier"` group, third parties in `"Third parties"`, etc. If there are more than ~40 nodes, group by domain and fold trivially similar things (e.g. 12 Lambda handlers behind one API Gateway route table can be one `function` node with many endpoints).

### 3. Ingest captured traffic (optional)

```bash
node "$TL/scripts/ingest.mjs" capture.har --client storefront -o .traffic-lens/har.events.jsonl
node "$TL/scripts/ingest.mjs" traces/ -o .traffic-lens/otel.events.jsonl
```

- Format is auto-detected: HAR, OTLP JSON / JSON-lines (collector file exporter), Jaeger JSON (UI "Download JSON" or API), Zipkin v2 JSON. A directory ingests every `.har/.json/.jsonl` inside it.
- `--client <node-id>` names the node the HAR was captured from (the browser app). Use the id of the frontend node from your graph.
- The output lists every distinct `source → target` pair. Compare those names against your nodes: if a target like `api.shop.dev` or `orders.svc.cluster.local:8080` is really one of your services, add it to that node's `aliases` before building.
- Ingest is privacy-preserving by design — it keeps method, host, path (no query), status, timing and *which kind* of credential was sent, never header values, cookies or bodies. Mention this if the user is wary of sharing captures.

### 4. Build the map

```bash
node "$TL/scripts/build.mjs" --graph .traffic-lens/code-graph.json \
  [--events .traffic-lens/har.events.jsonl --events .traffic-lens/otel.events.jsonl] \
  --out .traffic-lens/traffic-map.html --open
```

Optional: `--title`, `--subtitle`, `--error-rate 0.05` (health threshold), `--slow-ms 1000` (latency threshold). `--open` launches the browser; omit it if the environment has no display.

The build validates the graph first. On errors (unknown node referenced by an edge, duplicate ids, …) it exits non-zero with precise messages — fix the JSON and re-run. Warnings (unknown kind, flow step without a matching edge) don't block but are usually worth fixing.

Read the build summary carefully:
- **"nodes discovered only in traffic"** — either genuinely undocumented dependencies (keep them; they're a finding) or an alias you forgot (fix and rebuild).
- **connections confirmed / code-only / traffic-only** — a high traffic-only count usually means missing aliases, not missing code.

The build also writes `traffic-map.graph.json` (the merged graph with stats and findings) next to the HTML. Read it if you need to answer follow-up questions precisely.

### 5. Report back

Keep the chat summary short; the map is the deliverable. Include:
- the path to `traffic-map.html` (and that it is a self-contained file they can share — it works offline),
- one line on what's in it (e.g. "14 services, 31 connections, 4 flows; 1.2k requests from the HAR merged in"),
- the findings worth acting on, highest severity first, each as one line with the evidence (`file:line` or the observed numbers),
- anything the risk checklist turned up that the build didn't flag (risks noted only in `description`),
- anything you could not resolve (inferred edges, unknown hosts) so they know where the map is uncertain,
- if no traffic was used: one sentence on how adding a HAR or trace export would confirm the map and add health data.

Deep links work in the map (`traffic-map.html#node=orders-api`, `#tab=flows&flow=checkout`, `#tab=findings&finding=f2`, `#blast=orders-db`) — use them when pointing at something specific.

## Live mode

When the user wants to watch traffic as it happens (local dev, a load test, clicking through their app), serve the map instead of building a file:

```bash
node "$TL/scripts/serve.mjs" --graph .traffic-lens/code-graph.json \
  --watch telemetry/traces --watch captures --client <frontend-node-id> --port 4317 --open
```

It rebuilds whenever a watched file (or the code graph) changes; open pages update in place, keep their selection, and pulse the connections that got new requests. Run it in the background and give the user the URL. Watched trace files can be appended to while running.

## Comparing maps (diff)

To answer "what changed?" — a branch vs main, before vs after a refactor, last week's traffic vs today's — compare two maps:

```bash
node "$TL/scripts/diff.mjs" --base old.graph.json --head new.graph.json \
  --base-label main --head-label "my-branch" --out .traffic-lens/diff.html --md .traffic-lens/diff.md
```

Inputs can be built maps (`*.graph.json`, which carry traffic stats) or raw `code-graph.json` files. The output lists added/removed services and connections, route changes, health regressions (error-rate jumps, p95 slowdowns) and new/resolved findings; the HTML shows them on one map with a **Changes** tab. For a branch comparison, get the base code graph with `git show main:.traffic-lens/code-graph.json` — or scan the base checkout if none was committed.

To run this on every pull request, read `references/ci.md` (GitHub Actions workflow, PR comment, `--fail-on high` gate). `build.mjs --md report.md` writes a Markdown summary of a single map.

## What the viewer gives the user

So you can describe it accurately: pan/zoom canvas with orthogonal edges (ELK layout), node cards colored by kind, legend with counts that doubles as a filter, search (`/`), protocol/kind filters, animated particles showing direction of flow (line thickness scales with request volume when traffic exists), a health overlay coloring lines by error rate, a **Flows** tab that highlights one request's full path hop by hop — and, when traces were ingested, a **waterfall** of real sample requests (slowest / typical / failed) whose rows highlight the hop on the map — and a **Findings** tab with security / contract / health / structure checks that highlight the affected nodes and lines when clicked. Clicking a node shows routes it serves (with callers and hit counts), who calls it, what it calls, and a **Blast radius** button (everything that breaks if it goes down, and which flows). Clicking a line shows every route on it with stats, per-request repeat counts, timeouts and source locations.

## Findings the build computes

You don't compute these yourself, but your graph feeds them — the richer the `auth`, `exposure`, `endpoints`, `url`, `timeout`, `loop` and `cors` data, the better they get:

| Category | Checks |
|---|---|
| security | unauthenticated write or admin routes reachable from clients (login/sign-up/health and `public: true` routes excepted); public read routes; internal-only services reachable from outside; routes that require auth but accepted credential-less requests in traffic; plain-HTTP calls to non-local hosts (from traffic or from `url` in code); wildcard CORS on internal or sensitive routes |
| contract | calls to routes the target doesn't define (or with the wrong method); routes nobody calls; connections seen in traffic but not in code; connections in code never observed in traffic |
| health | error rate above threshold; p95 latency above threshold; N+1 calls (same call repeated ≥ 5× inside one traced request, or marked `loop` in code); chatty flows (≥ 15 calls per request); sync calls with `timeout: "none"` |
| structure | synchronous call cycles; very high fan-out; single points of failure (nodes in ≥ 80% of flows) |

## Reference files

- `references/graph-schema.md` — the code-graph JSON format, field by field, with a full example. Read before writing the graph.
- `references/code-scan.md` — detection patterns by language/framework, URL resolution, auth/exposure detection, multi-repo stitching. Read before scanning.
- `references/capturing-traffic.md` — how a user captures a HAR or exports traces from Jaeger/Zipkin/OTel collectors/vendors. Read when the user asks how to provide traffic, or when suggesting it.
- `references/ci.md` — running map diffs on pull requests (GitHub Actions workflow, PR comment, failing on new high-severity findings). Read when the user wants the map in CI or on PRs.
