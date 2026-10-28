# Code graph format

The file you write in step 2 (`code-graph.json`). `build.mjs` validates it, merges traffic into it and adds stats/findings. Only `nodes[].id` and `edges[].source/target` are strictly required; everything else makes the map richer.

## Contents
- Top level
- Nodes (and endpoints)
- Edges (and calls)
- Flows
- Groups and notes
- Route syntax
- Full example

## Top level

```json
{
  "title": "Commerce platform",
  "subtitle": "Traffic map · scanned 2026-10-26",
  "groups": [ ... ],
  "nodes": [ ... ],
  "edges": [ ... ],
  "flows": [ ... ],
  "notes": [ "Gateway strips /api/v1 before forwarding" ]
}
```

## Nodes

One per deployable unit or external dependency.

| field | type | notes |
|---|---|---|
| `id` | string | unique, kebab-case, stable (`orders-api`) |
| `label` | string | display name (`Orders API`) |
| `kind` | enum | `client` `gateway` `auth` `service` `function` `worker` `queue` `cache` `database` `search` `storage` `external` |
| `tech` | string | short subtitle on the card: `Next.js`, `FastAPI`, `PostgreSQL`, `Kafka topic` |
| `description` | string | one sentence, shown in the detail panel |
| `location` | string | folder or file that defines it: `services/orders` |
| `repo` | string | repo name when scanning several repos |
| `group` | string | id of a group in `groups` |
| `exposure` | `public` \| `internal` | reachable from the internet or not (ingress, published port, public gateway route). Drives security findings. Omit if unknown |
| `aliases` | string[] | every name traffic might use for it: hostnames, `host:port`, compose/k8s service names, OTel `service.name`, queue/topic names |
| `endpoints` | Endpoint[] | routes this node **serves** (HTTP/gRPC/GraphQL/WebSocket). Omit for nodes you didn't scan (externals) — an empty or missing list disables contract checks against that node |

Kind guide: `client` = browser/mobile/desktop/CLI apps and anything outside the system that initiates calls. `gateway` = API gateways, reverse proxies, BFFs whose job is routing. `auth` = identity/session/token services (shown as "Security"). `function` = serverless handlers. `worker` = queue consumers, cron/batch jobs. `external` = third-party APIs (Stripe, OpenAI, Twilio, SendGrid…).

### Endpoint

```json
{ "method": "POST", "path": "/orders/:id/refund", "auth": "jwt", "location": "services/orders/src/routes.ts:88" }
```

| field | notes |
|---|---|
| `method` | HTTP verb, `ANY`, `RPC` for gRPC, `QUERY`/`MUTATION`/`SUBSCRIPTION` for GraphQL, `WS` for WebSocket |
| `path` | route as declared — any param syntax is fine (see Route syntax) |
| `operation` | GraphQL operation / gRPC method name when the path alone isn't distinctive (`/graphql` + `CreateOrder`) |
| `auth` | what the server **requires**: `none` (explicitly public), `jwt`, `session`, `apikey`, `oauth`, `basic`, `mtls`, `internal` (network-trust only), `signature` (webhook HMAC). Omit when you can't tell — `none` must mean you saw that no auth is applied |
| `public` | `true` when the route is meant for anonymous users (login, sign-up, password reset, public catalogue). Login/sign-up/health-style paths are recognised automatically; use this for others so they aren't flagged as unauthenticated |
| `cors` | `"*"` when the route answers with `Access-Control-Allow-Origin: *` (flagged on internal services and sensitive routes) |
| `location` | `file:line` of the route definition |

## Edges

One per **source → target pair** (plus protocol if the same pair talks two ways, e.g. HTTP and WebSocket). Put individual routes in `calls`, not separate edges.

| field | type | notes |
|---|---|---|
| `source`, `target` | node id | the caller and the callee |
| `protocol` | enum | `http` `graphql` `grpc` `websocket` `sse` `sql` `nosql` `redis` `queue` `kafka` `amqp` `sqs` `pubsub` `s3` `smtp` `tcp` `other` |
| `async` | bool | true for fire-and-forget: queues, topics, events, webhooks you emit |
| `confidence` | `high` \| `inferred` | `inferred` when the target came from a guess (unresolved env var, naming convention) |
| `description` | string | why it exists / how it was inferred |
| `calls` | Call[] | the concrete operations |

Queues are nodes: a producer → topic edge (`async: true`) and a topic → consumer edge (`async: true`). Don't draw producer → consumer directly.

### Call

```json
{ "method": "GET", "path": "/orders/${orderId}", "auth": "jwt", "locations": ["apps/web/lib/orders.ts:31"] }
```

| field | notes |
|---|---|
| `method` | HTTP verb; for data stores the operation (`SELECT`, `INSERT`, `GET`, `SET`, `PUT`); for queues `PUBLISH` / `RECEIVE` |
| `path` | route called (HTTP/gRPC), object key pattern (S3), or `""` for DB/cache/queue calls |
| `operation` | table/collection, cache key pattern, event name, GraphQL operation |
| `auth` | credential the caller **sends**: `jwt`, `session`, `apikey`, `none`, … |
| `url` | the URL as written in code, when it's a literal or resolves to one (`http://jsonplaceholder.typicode.com/users`). Plain `http://` to a non-local host is flagged even if browsers upgrade it at runtime |
| `timeout` | ms, or `"none"` when the client has no timeout/abort (`fetch` without `signal`, `requests` without `timeout=`). Omit when unknown. `"none"` on sync calls is flagged |
| `loop` | set when the call runs once per item of a collection inside one request (`for … await fetch`, `Promise.all(items.map(fetch…))`, a query per row). `true`, or a short string naming what it iterates (`"posts"`). Flagged as a possible N+1; traces then show the real repeat count |
| `locations` | every `file:line` that makes this call |

## Flows

Key request journeys for the Flows tab. Build adds flows reconstructed from traces automatically and merges them with yours when the entry matches.

```json
{
  "id": "checkout",
  "name": "Checkout",
  "description": "Customer pays for their cart",
  "entry": { "node": "gateway", "method": "POST", "path": "/checkout" },
  "steps": ["web->gateway", "gateway->auth", "gateway->orders-api", "orders-api->stripe", "orders-api->order-events", "order-events->fulfilment"]
}
```

`steps` are `"source->target"` references to edges, in the order the request travels. Every step must match an edge or it is dropped (with a warning).

## Groups and notes

```json
"groups": [{ "id": "data", "label": "Data tier" }, { "id": "third", "label": "Third parties" }]
```

Nodes reference a group with `"group": "data"`. Groups render as labelled containers. `notes` are short strings shown on the overview panel — use them for scan caveats ("payments repo not scanned — Stripe edge inferred from SDK import").

## Route syntax

Write paths as they appear in code; build normalizes all of these to `:param` and matches them against each other and against observed traffic (`/orders/8812` matches `/orders/:id`):

`/orders/:id` · `/orders/{id}` · `/orders/<int:id>` · `/orders/[id]` · `/orders/${orderId}` · catch-all `/files/*` or `[...slug]`

Drop query strings. If a gateway rewrites prefixes (`/api/v1/orders` → `/orders`), record each side as it appears in its own code and add a note.

## Full example

```json
{
  "title": "Commerce API",
  "subtitle": "Production topology",
  "groups": [{ "id": "data", "label": "Data tier" }],
  "nodes": [
    { "id": "web", "label": "Storefront", "kind": "client", "tech": "Next.js", "location": "apps/web", "aliases": ["localhost:3000"] },
    { "id": "gateway", "label": "Edge gateway", "kind": "gateway", "tech": "Envoy", "exposure": "public",
      "location": "infra/envoy.yaml", "aliases": ["api.shop.dev", "gateway:8080"] },
    { "id": "orders-api", "label": "orders-api", "kind": "service", "tech": "Express · REST", "exposure": "internal",
      "location": "services/orders", "aliases": ["orders-api:4000", "orders-api"],
      "endpoints": [
        { "method": "POST", "path": "/checkout", "auth": "jwt", "location": "services/orders/src/routes/checkout.ts:22" },
        { "method": "GET", "path": "/orders/:id", "auth": "jwt", "location": "services/orders/src/routes/orders.ts:11" }
      ] },
    { "id": "stripe", "label": "Stripe", "kind": "external", "tech": "Payments", "aliases": ["api.stripe.com"] },
    { "id": "order-events", "label": "order.created", "kind": "queue", "tech": "Kafka topic", "aliases": ["order-events"] },
    { "id": "fulfilment", "label": "Fulfilment worker", "kind": "worker", "tech": "Node consumer", "location": "services/fulfilment" },
    { "id": "orders-db", "label": "Orders DB", "kind": "database", "tech": "PostgreSQL", "group": "data", "aliases": ["orders-db:5432"] }
  ],
  "edges": [
    { "source": "web", "target": "gateway", "protocol": "http", "calls": [
      { "method": "POST", "path": "/checkout", "auth": "jwt", "locations": ["apps/web/app/checkout/actions.ts:31"] },
      { "method": "GET", "path": "/orders/${id}", "auth": "jwt", "locations": ["apps/web/lib/orders.ts:9"] } ] },
    { "source": "gateway", "target": "orders-api", "protocol": "http", "calls": [
      { "method": "ANY", "path": "/*", "locations": ["infra/envoy.yaml:40"] } ] },
    { "source": "orders-api", "target": "stripe", "protocol": "http", "calls": [
      { "method": "POST", "path": "/v1/payment_intents", "locations": ["services/orders/src/payments.ts:27"] } ] },
    { "source": "orders-api", "target": "order-events", "protocol": "kafka", "async": true, "calls": [
      { "method": "PUBLISH", "path": "", "operation": "order.created", "locations": ["services/orders/src/events.ts:15"] } ] },
    { "source": "order-events", "target": "fulfilment", "protocol": "kafka", "async": true, "calls": [
      { "method": "RECEIVE", "path": "", "operation": "order.created", "locations": ["services/fulfilment/src/consumer.ts:9"] } ] },
    { "source": "orders-api", "target": "orders-db", "protocol": "sql", "calls": [
      { "method": "INSERT", "path": "", "operation": "orders", "locations": ["services/orders/src/db.ts:44"] } ] }
  ],
  "flows": [
    { "id": "checkout", "name": "Checkout", "entry": { "node": "gateway", "method": "POST", "path": "/checkout" },
      "steps": ["web->gateway", "gateway->orders-api", "orders-api->stripe", "orders-api->orders-db", "orders-api->order-events", "order-events->fulfilment"] }
  ]
}
```
