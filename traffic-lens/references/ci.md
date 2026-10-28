# Traffic-map diffs in CI

Goal: every pull request that changes how services talk to each other gets a comment like
"➕ 1 new connection · 🆕 2 new findings", plus the interactive diff map as a build artifact,
and optionally a failing check when it introduces high-severity findings.

## How it fits together

1. **The code graph is committed.** `.traffic-lens/code-graph.json` is the scan output. Commit
   it (not the HTML or events). Whoever changes service-to-service calls re-runs the skill
   ("update the traffic map") in the same PR, the same way they'd update an API spec.
2. **The skill's runtime is vendored.** Copy the skill's `scripts/` and `assets/` folders into the
   repo, e.g. `tools/traffic-lens/`. They have no dependencies; Node 18+ is all CI needs.
3. **CI diffs base vs head** with `scripts/diff.mjs`. Raw code graphs are accepted and built on
   the fly, so no traffic is needed in CI.

When setting this up for a user: copy the two folders, write the workflow below, add
`.traffic-lens/*` except `code-graph.json` to `.gitignore`, and commit the current code graph as
the baseline.

## GitHub Actions

`.github/workflows/traffic-map.yml`:

```yaml
name: Traffic map
on:
  pull_request:
    paths: ['.traffic-lens/code-graph.json']

permissions:
  contents: read
  pull-requests: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Base graph
        run: |
          git show "origin/${{ github.base_ref }}:.traffic-lens/code-graph.json" > "$RUNNER_TEMP/base.json" \
            || echo '{"nodes":[],"edges":[]}' > "$RUNNER_TEMP/base.json"

      - name: Diff
        run: |
          node tools/traffic-lens/scripts/diff.mjs \
            --base "$RUNNER_TEMP/base.json" --head .traffic-lens/code-graph.json \
            --base-label "${{ github.base_ref }}" --head-label "PR #${{ github.event.pull_request.number }}" \
            --out traffic-diff.html --md traffic-diff.md \
            --fail-on high

      - name: Upload diff map
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: traffic-diff
          path: traffic-diff.html

      - name: Comment on the PR
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          [ -f traffic-diff.md ] || exit 0
          gh pr comment "$PR" --body-file traffic-diff.md --edit-last \
            || gh pr comment "$PR" --body-file traffic-diff.md
```

- `--fail-on high` makes the step exit with code 2 when the PR adds a high-severity finding (use
  `medium` to be stricter, or drop it to only comment). The report is written before the exit,
  so the comment and artifact still go out.
- `--edit-last` keeps one comment per PR up to date instead of adding a new one on every push.
- Other CI systems: the same three commands (get base graph, run `diff.mjs`, post the Markdown).

## Diffing traffic, not just code

`diff.mjs` also compares built maps (`*.graph.json`), which include traffic stats. To catch
health regressions between releases, build a map from a staging trace export before and after
a deploy and diff the two: error-rate jumps (≥ 5 points) and p95 slowdowns (≥ 1.5× and ≥ 200 ms)
show up under **Health**.

## Single-map report

`build.mjs --md report.md` writes a Markdown summary of one map (counts, findings by severity,
inferred connections) — handy for a scheduled job or a wiki page.
