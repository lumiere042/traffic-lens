# traffic-lens

**See what talks to what in your system.** traffic-lens is a [Claude Code](https://claude.com/claude-code) skill that maps every API call between your apps, services, workers, databases, queues and third-party APIs, and turns it into an interactive diagram you can open in any browser.

https://github.com/user-attachments/assets/ddbbb3b2-80e5-44e7-8964-2c85925883ce

## Why

Architecture diagrams go stale, and they rarely show the details you actually need: which service calls which route, whether it's authenticated, and what breaks when something goes down. traffic-lens builds the map from the system itself:

- **The code**: Claude reads your repo(s) and records every route served and every call made, with the `file:line` that makes it.
- **Real traffic** (optional): browser HAR captures and OpenTelemetry, Jaeger or Zipkin traces are merged in, so the map shows what actually happens, not just what the code says.

Where the two disagree, you get a finding.

## What you get

A single, self-contained HTML file that works offline and is easy to share:

- **Map**: services as cards and calls as lines. Animated particles show the direction of traffic, line thickness shows volume, and color shows health.
- **Click anything**: a service shows the routes it serves, who calls it and what it calls. A line shows every route on it, with request counts, error rates, latency and source locations.
- **Flows**: follow one request (e.g. checkout) hop by hop across the system, with a waterfall of real sample requests when traces are available.
- **Blast radius**: pick a service and see everything that breaks if it goes down.
- **Findings**: automatic checks, each one highlighted on the map:

| Category | Examples |
|---|---|
| Security | unauthenticated write/admin routes, internal services reachable from outside, plain-HTTP calls, wildcard CORS |
| Contract | calls to routes that don't exist, routes nobody calls, traffic the code doesn't explain |
| Health | high error rates, slow calls, N+1 call patterns, missing timeouts |
| Structure | call cycles, single points of failure, excessive fan-out |

Two extras:

- **Live mode** updates the map in place while you click through your app.
- **Diff mode** compares two maps (branch vs main, before vs after) and can comment on pull requests in CI.

## Install

Requires [Claude Code](https://claude.com/claude-code) and Node.js 18+. There are no npm dependencies.

Clone the repo and put the `traffic-lens/` folder in your Claude skills directory:

```bash
git clone https://github.com/lumiere042/traffic-lens.git
cp -r traffic-lens/traffic-lens ~/.claude/skills/traffic-lens
```

On Windows (PowerShell), you can link the folder instead so that updates from `git pull` apply automatically:

```powershell
New-Item -ItemType Junction -Path "$HOME\.claude\skills\traffic-lens" -Target "<path-to-clone>\traffic-lens"
```

## Use

Open Claude Code in your project and ask in plain language:

> map the API traffic in this repo
>
> how do our services connect?
>
> visualize this .har file
>
> which endpoints are unauthenticated or never called?

Claude scans the code, merges any traffic you point it at, and writes `.traffic-lens/traffic-map.html`, then summarizes the most important findings.

### Try it without Claude

The bundled scripts also run on their own. To build a map from the sample Jaeger traces:

```bash
node traffic-lens/scripts/ingest.mjs fixtures/jaeger-export.json -o events.jsonl
node traffic-lens/scripts/build.mjs --events events.jsonl --out traffic-map.html --open
```

## Repository layout

| Path | What it is |
|---|---|
| [`traffic-lens/`](traffic-lens) | The skill: instructions (`SKILL.md`), reference docs, scripts and the HTML viewer |
| [`postboard/`](postboard) | A small multi-service demo app for testing the skill end to end ([README](postboard/README.md)) |
| [`fixtures/`](fixtures) | Sample HAR files, traces and a sample codebase, plus tests (`node fixtures/test.mjs`) |
| [`media/`](media) | The demo video |

## How it works

The skill splits the work between Claude and plain scripts:

1. **Claude** reads the code and writes a `code-graph.json` describing services, the routes they serve, the calls they make and the key request flows. This is the part that needs judgement.
2. **Scripts** (`ingest.mjs`, `build.mjs`) do everything deterministic: parse captured traffic, merge it with the graph, compute stats and findings, and render the viewer. The same input always gives the same map.

Ingesting traffic is privacy-preserving: only the method, host, path, status, timing and the *kind* of credential are kept. Header values, cookies, query strings and request bodies are never kept.

## License

[MIT](LICENSE). Bundled third-party code: [ELK.js](traffic-lens/assets/vendor/ELK-LICENSE.md) (EPL-2.0) for graph layout.
