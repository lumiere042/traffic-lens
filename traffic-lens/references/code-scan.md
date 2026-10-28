# Scanning code for traffic

How to find nodes, the routes they serve, the calls they make, and where those calls actually go. Use Grep/Glob to locate candidates, then Read the surrounding code to confirm — a grep hit is a lead, not evidence.

## Contents
1. Inventory deployables
2. Routes served (endpoints)
3. Outbound calls
4. Data stores, caches, queues, storage, third parties
5. Resolving where a call goes
6. Auth and exposure
7. Multi-repo stitching
8. Pitfalls
9. Risk checklist (run before writing the graph)

## 1. Inventory deployables

Look for, in roughly this order:
- `docker-compose*.yml` / `compose.yaml` — each service is a node; `image: postgres|redis|rabbitmq|kafka|localstack|minio` are infra nodes; `ports:` mapping to the host suggests `exposure: public` in dev — confirm against prod config.
- Kubernetes / Helm (`k8s/`, `deploy/`, `charts/`, `*.yaml` with `kind: Deployment|Service|Ingress|CronJob`). `Ingress`/`LoadBalancer` → public. `CronJob` → `worker`.
- Monorepo manifests: `package.json` workspaces, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `go.work`, Cargo workspaces, Gradle/Maven multi-module, `apps/*`, `services/*`, `packages/*` (packages are usually libraries, not nodes).
- `Procfile`, `fly.toml`, `render.yaml`, `app.yaml`, `vercel.json`, `netlify.toml`, `serverless.yml`, SAM/CDK/Terraform (`aws_lambda_function`, `aws_sqs_queue`, `aws_s3_bucket`, `aws_api_gateway*`).
- Frontends: Next.js/Nuxt/SvelteKit/Remix apps (note: these have a *server* side too — API routes / server actions / loaders run server-side; model as one node unless they call different things from browser vs server and that distinction matters), React/Vue SPAs, mobile apps (`ios/`, `android/`, React Native, Flutter).

## 2. Routes served (endpoints)

| Stack | Look for |
|---|---|
| Express / Koa / Hono / Fastify | `app.get(`, `router.post(`, `fastify.route({ method, url })`, `app.use('/prefix', router)` — **prefixes compose**, follow `use()` mounts |
| NestJS | `@Controller('orders')` + `@Get(':id')`, `@Post()`; global prefix `app.setGlobalPrefix` |
| Next.js | `app/**/route.ts` exporting `GET/POST/...` (path = folder path, `[id]` params); `pages/api/**`; server actions (`'use server'`) are POSTs to the page |
| tRPC | `router({ getOrder: publicProcedure... })` → `QUERY`/`MUTATION` with `operation` = procedure path; `protectedProcedure` → auth |
| GraphQL servers | schema `type Query/Mutation` fields → endpoints on `/graphql` with `operation` |
| FastAPI | `@app.get("/x")`, `APIRouter(prefix="/orders")`, `app.include_router(r, prefix=...)`, `Depends(get_current_user)` → auth |
| Flask | `@app.route("/x", methods=[...])`, blueprints `url_prefix`, `@login_required` |
| Django / DRF | `urls.py` `path()`/`re_path()`, `include()` prefixes, `ViewSet` + router (list/create/retrieve/update/destroy), `permission_classes` |
| Go | `http.HandleFunc`, `mux.HandleFunc(...).Methods`, gin `r.GET`, chi `r.Route`, echo `e.POST`, fiber `app.Get`; Go 1.22 `mux.Handle("POST /x/{id}", ...)` |
| Java / Kotlin | Spring `@RestController` + `@RequestMapping` + `@GetMapping`; JAX-RS `@Path` `@GET`; Ktor `routing { get("/x") }` |
| .NET | `[ApiController]` `[Route]` `[HttpGet("{id}")]`; minimal APIs `app.MapGet`; `[Authorize]` / `[AllowAnonymous]` |
| Ruby | `config/routes.rb` (`resources :orders` expands to 7 REST routes), Sinatra `get '/x'` |
| PHP | Laravel `Route::get`, `Route::apiResource`, middleware `auth:sanctum`; Symfony `#[Route]` |
| gRPC | `.proto` `service X { rpc Y(...) }` → endpoints `RPC /package.X/Y` |
| WebSocket / SSE | `new WebSocketServer`, `socket.io` `io.on('connection')` + `socket.on('event')`, `text/event-stream` responses |
| Webhooks | routes like `/webhooks/stripe` — note them; they are called *by* an external node (draw external → service edge) |

## 3. Outbound calls

| Stack | HTTP clients / SDK patterns |
|---|---|
| JS/TS | `fetch(`, `axios.get/post/create`, `ky`, `got`, `ofetch`/`$fetch`, `superagent`, `undici.request`, SWR/React Query fetchers, Apollo/urql `gql` operations, tRPC client `trpc.x.useQuery`, `new WebSocket(`, `io(`, `new EventSource(` |
| Python | `requests.`, `httpx.`, `aiohttp.ClientSession`, `urllib3`, `urlopen`, generated OpenAPI clients, `grpc.insecure_channel` / stubs |
| Go | `http.Get/Post/NewRequest`, `client.Do`, `resty`, gRPC `NewXClient(conn)` |
| Java/Kotlin | `RestTemplate`, `WebClient`, `@FeignClient(url=...)`, `OkHttp`, `HttpClient`, Retrofit interfaces |
| .NET | `HttpClient`, `IHttpClientFactory` named clients, Refit interfaces |
| Ruby / PHP | `Faraday`, `HTTParty`, `Net::HTTP`, Guzzle, `Http::get` (Laravel) |

For each hit capture: method, path (as written, including template params), the base URL expression, and `file:line`. Group calls by resolved target into one edge. Also record:
- `url` when the full URL is a literal (or a constant/env default) — it is how plain `http://` gets caught.
- `timeout`: the configured timeout in ms, or `"none"` when there is none. `fetch`/`undici` without `signal: AbortSignal.timeout(...)`, `axios` without `timeout`, Python `requests` without `timeout=`, Go `http.Client{}` without `Timeout` all mean `"none"`. A shared client factory sets it for every call through it.

**Proxies and gateways.** A catch-all forward (`app.all('/api/*', proxy)`, nginx `location /api/`, `http-proxy-middleware`, Next.js rewrites) hides which routes actually reach the backend. Expand it: on the gateway → backend edge, list the concrete routes that clients send through the proxy (with the prefix rewritten as the proxy does) and cite both the proxy line and the client call. That's what lets the contract check catch a client calling a route the backend doesn't have.

Generated API clients (OpenAPI, gRPC stubs, GraphQL codegen) hide paths behind method names — find the spec/proto they were generated from to get the real routes.

## 4. Data stores, caches, queues, storage, third parties

| Kind | Signals |
|---|---|
| database | Prisma (`schema.prisma` datasource + `prisma.order.findMany` → `SELECT orders`), TypeORM/Sequelize/Drizzle/Knex, Mongoose models, SQLAlchemy/Django ORM models, GORM, JDBC/JPA repositories, `pg`/`mysql2`/`psycopg` connections; `DATABASE_URL` |
| cache | `ioredis`/`redis` clients, `@nestjs/cache-manager`, Django cache, `memcached`; `REDIS_URL` |
| queue | Kafka (`producer.send({ topic })`, `consumer.subscribe`), RabbitMQ (`channel.publish/consume`, `sendToQueue`), SQS (`SendMessageCommand`, `ReceiveMessage`), SNS, Google Pub/Sub, NATS, BullMQ (`new Queue('x').add` / `new Worker('x')`), Celery (`task.delay`, `@app.task`), Sidekiq (`perform_async`), Laravel jobs, Redis streams |
| storage | S3 (`PutObjectCommand`, `getSignedUrl`, `boto3.client('s3')`), GCS, Azure Blob, MinIO, local volume uploads |
| search | Elasticsearch/OpenSearch, Algolia, Meilisearch, Typesense clients |
| external | SDK imports: `stripe`, `openai`, `@anthropic-ai/sdk`, `twilio`, `@sendgrid/mail`, `resend`, `postmark`, `@slack/web-api`, `firebase-admin`, `@aws-sdk/*` (non-storage), `googleapis`, `plaid`, `shopify`, analytics (`segment`, `posthog`, `mixpanel`), monitoring (`@sentry/*` — usually omit unless asked); plus raw HTTP calls to public hostnames |

Make each queue/topic its own node (`kind: queue`) named after the topic, with producer → topic and topic → consumer edges, both `async: true`. Make each distinct database its own node (not one per table) — tables go in `calls[].operation`.

## 5. Resolving where a call goes

The base URL is usually indirect. Trace it until it names a node:

1. Literal URL → host → match a node alias or create an external node.
2. Env var (`process.env.ORDERS_URL`, `os.environ["X"]`, `@Value("${x}")`, `viper.GetString`) → look in `.env*`, `.env.example`, compose `environment:`/`env_file:`, k8s `env:`/ConfigMaps/Secrets refs, Helm `values*.yaml`, Terraform outputs, CI deploy configs.
3. Client factory (`axios.create({ baseURL: config.ordersUrl })`, a `lib/api.ts` wrapper) → resolve once, then every call through that client inherits the target.
4. Service discovery names: compose service `orders:` is reachable as `http://orders:4000`; k8s Service `orders` as `orders`, `orders.<ns>`, `orders.<ns>.svc.cluster.local`. Add these as aliases.
5. Frontend → backend: dev proxies (`next.config.js` rewrites, Vite `server.proxy`, CRA `proxy`), relative `fetch('/api/x')` hits the frontend's own origin — then follow the rewrite or the API route.
6. Still unresolved: draw the edge to the most likely node with `"confidence": "inferred"` and a `description` explaining the guess, or to an external node named after the env var (`ORDERS_URL (unresolved)`) if there's no good guess. Mention it in your report.

## 6. Auth and exposure

**Endpoint `auth`** (what the server requires): find the middleware chain on the route or its router/prefix. Common signals: `passport.authenticate`, `requireAuth`/`isAuthenticated`, `@UseGuards(AuthGuard)`, `protectedProcedure`, `Depends(get_current_user)`, `@login_required`, `permission_classes = [IsAuthenticated]`, `[Authorize]`, `@PreAuthorize`, `before_action :authenticate_user!`, `auth:sanctum`, API-key header checks, `verifyWebhookSignature` (→ `signature`). A global auth middleware applied before the router covers everything unless a route opts out (`@Public()`, `[AllowAnonymous]`, `skip_before_action`). Set `auth: "none"` only when you can see no auth applies; otherwise omit it.

**Call `auth`** (what the caller sends): `Authorization: Bearer`, cookies/`credentials: 'include'`, `x-api-key`, SDK keys. Check each call site, not just the shared helper — one-off `fetch` calls that bypass the authenticated client are a classic bug.

**Endpoint `public` / `cors`**: mark routes that must be anonymous (login, sign-up, password reset, public pages) with `public: true` if their path doesn't already say so. Record `cors: "*"` where a route or middleware sets `Access-Control-Allow-Origin: *` (`cors()` with no options, manual `setHeader`).

**Node `exposure`**: `public` if it has an Ingress/LoadBalancer/public gateway route/published port in production config or is a third-party-facing webhook receiver; `internal` if only reachable on the private network. The gateway's routing table is the best evidence: services behind it are `internal`, the gateway is `public`.

## 7. Multi-repo stitching

When scanning several repos:
- Give each node a `repo` field.
- Collect every service's *names* (compose/k8s service name, hostname in ingress, OTel `service.name` from tracing setup code, package name) into `aliases` first, then resolve outbound base URLs against that alias table — that's what links repo A's `ORDERS_URL=http://orders-api:4000` to repo B's orders service.
- A target that matches nothing in any scanned repo becomes a node with `"tech": "Not scanned"` (or `external` if it's a public host). Say so in `notes`.

## 8. Pitfalls

- **Libraries aren't services.** A shared `packages/api-client` is the *mechanism* for calls; attribute calls to the deployable that imports and executes it.
- **Test/mocks/fixtures/storybook/scripts** — skip calls that only occur in `*.test.*`, `__mocks__`, `fixtures`, seeds, one-off scripts — unless the user asks.
- **Dead code** — calls behind permanently-off feature flags are still worth drawing, but say so in `description`.
- **Same path, different services** — `/health` exists everywhere; never match routes across nodes by path alone, only within the resolved target.
- **Gateways rewrite paths** — record each hop's path as its own code sees it; add a note about the rewrite so contract findings make sense.
- **Don't let the map explode** — fold N identical lambdas/handlers into one node, keep internal modules out, and use groups.

## 9. Risk checklist (run before writing the graph)

The build's findings are only as good as the facts you record. These are the patterns that real bugs hide in; each one names what to look at and which field carries it into a finding. Go through the list once per service. **Record what the code does, not what it was meant to do.** Never "fix" a wrong method or a missing auth check in the graph. The mismatch is the finding.

**Auth gaps** → endpoint `auth`, call `auth`
- **Sensitive routes.** For every route under `admin`, `internal`, `debug`, `ops`, `manage*`, `actuator`, or one that resets, deletes in bulk, or exports, find the auth on that exact route. Admin routes are often registered before the auth middleware or on a separate router that never got it.
- **Method-selective guards.** Watch for auth that checks the method (`if (['POST','PUT','DELETE'].includes(req.method))`, `router.post(…, requireAuth)` while `router.patch(…)` has none, `@PreAuthorize` on some handlers of a controller only). List each method's route with its own `auth`. The method left out (often `PATCH`, sometimes `HEAD`/`OPTIONS`) is the hole.
- **Opt-outs.** `@Public()`, `[AllowAnonymous]`, `skip_before_action`, and routes mounted before `app.use(auth)` override a global guard. Mark those routes `auth: "none"`.
- **Call sites that skip credentials.** The app has an authenticated helper (`api.post`, `authFetch`), but one call uses raw `fetch`/`axios` with no `Authorization` header or `credentials`. Give that call `auth: "none"` even when the shared helper sends a token.

**Exposure leaks** → node `exposure`, client edges, call `url`
- **Clients talking to internal services directly.** Look for hard-coded `localhost:<port>`, internal hostnames, or env vars pointing past the gateway (`STATUS_URL`, `HEALTH_URL`, `*_INTERNAL_URL`) in browser or mobile code. Draw the client → internal-service edge. Don't route it through the gateway because "it should go there".
- **Plain HTTP.** Every literal `http://` URL to a non-local host goes in `url`, in clients and in config defaults alike. Browsers silently upgrade some of these, so traffic alone won't show it.
- **Wildcard CORS.** `cors()` with no options, `origin: '*'`, `origin: true` reflecting any origin, or a manual `Access-Control-Allow-Origin: *`. Set `cors: "*"` on the affected routes, including health/status routes on internal services.

**Contract mismatches** → call `method`/`path` vs the target's `endpoints`
- **Check calls against routes.** For each call to a service you scanned, find the target route with the same method. Common misses: `POST` where the server defines `PUT`, singular vs plural paths, a missing prefix the server mounts, or a route the client calls that was never implemented. Record the call exactly as written.
- **Routes with no caller.** List every route a service serves, not only the ones you saw called. Leftover `refresh`, `export`, `v1` routes are what the "never called" check is for.
- **Proxied routes.** Behind a catch-all proxy, expand to the concrete client routes (see §3). Otherwise every contract check through the gateway is blind.

**Hidden dependencies** → nodes and edges
- **Non-network side effects.** Writes to local disk or a shared volume (`fs.writeFile`, `open(…,'w')`, upload directories, export folders) are dependencies too. Model them as a `storage` node. Traces rarely record file I/O, so these often show as "never observed", which is correct and worth knowing.
- **Background senders.** Workers and consumers often call back into APIs (`PUT /items/:id/processed`) or out to webhooks. Read the consumer's handler, not just its subscription.
- **Config-only targets.** Webhook URLs, callback URLs and third-party endpoints that live only in env/config defaults or the process launcher (`start.mjs`, compose, Procfile) still get an edge.

**Resilience** → call `timeout`, call `loop`, edge direction
- **Timeouts.** Record `timeout` on every server-side call: ms when set (`AbortSignal.timeout`, `timeout:`, client defaults), `"none"` when absent. Check every call site. Teams often add a timeout to the main client and forget the one-off calls (auth checks, webhooks, callbacks).
- **Calls in loops (N+1).** A call inside `for`/`forEach`/`map`, `Promise.all(items.map(…))`, or a per-row query (`users.find(id)` in a list handler) gets `loop` (e.g. `"loop": "posts"`). Also look one level down: a list handler calling a helper that calls another service per item is the same problem.
- **Back-calls.** If service A calls B and any B handler calls A, draw both edges and don't merge them. Synchronous cycles are a structure finding.

When the scan turns up something risky that no field captures (an unbounded full-table scan, a deliberate `sleep`, an upstream write that fails for locally-created ids), put it in that call's or edge's `description` and mention it in your report. Traffic will usually confirm it as an error or slow-call finding.
