# PR Reviewer Agent

A multi-agent PR reviewer for GitHub. Given a PR, it runs 8 specialized reviewer agents (bug
hunter, security, performance, architecture, testing, API/database, framework specialist,
DevOps/CI) in parallel against the actual checked-out repository, then runs an independent
fresh-context VERIFY agent that re-derives every candidate finding from the repo before anything
is reported. The final verdict (`APPROVE` / `APPROVE WITH COMMENTS` / `REQUEST CHANGES`) is
computed from verified finding severities, not asserted by an agent.

For a deep technical reference (every module, schema, and gate) see
[`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md). For a short, non-technical project brief
(also handy to share as a PDF) see [`docs/PR_Reviewer_Agent_Context.pdf`](docs/PR_Reviewer_Agent_Context.pdf)
— regenerate it after editing `docs/context-source.html` with:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-sandbox \
  --print-to-pdf=docs/PR_Reviewer_Agent_Context.pdf \
  --no-pdf-header-footer \
  "file://$(pwd)/docs/context-source.html"
```

Each agent is a real [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
session with `Read`/`Grep`/`Glob`/`Bash` access to the checked-out PR branch — it reads real files,
traces real call sites, and returns structured JSON (enforced via `outputFormat: json_schema`), not
free-form prose.

## Requirements

- Node.js 18+
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated: `gh auth login`
- Claude access for the Agent SDK: either `claude login` (if you use Claude Code locally — this
  reuses that login) or an `ANTHROPIC_API_KEY` environment variable (required in CI, e.g. GitHub
  Actions, where there's no interactive login)

## Install

```bash
npm install
```

## CLI usage

```bash
# Review a PR by URL, print the report, don't post anywhere
node bin/pr-review.js https://github.com/owner/repo/pull/123

# Same, by repo/number
node bin/pr-review.js --repo owner/repo --pr 123

# Save the report to a file
node bin/pr-review.js https://github.com/owner/repo/pull/123 --out review.md

# Post the report as a PR comment (uses `gh pr comment` under your authenticated gh account)
node bin/pr-review.js https://github.com/owner/repo/pull/123 --post

# Force a re-run even if this exact commit was already reviewed
node bin/pr-review.js https://github.com/owner/repo/pull/123 --force

# Review an already-checked-out local directory instead of cloning
node bin/pr-review.js --repo owner/repo --pr 123 --local-dir ../path/to/checkout
```

`--post` calls `gh pr comment`, which is visible to everyone on the PR — it is never on by
default; you must pass it explicitly.

Full flag list: `node bin/pr-review.js --help`.

## What it does

1. Fetches PR metadata, diff, and changed files via `gh`.
2. Clones the repo and checks out the PR branch (or reuses `--local-dir`).
3. Runs a discovery agent to detect languages/frameworks/architecture, the PR's intent, and
   project invariants (only ones it can point to concrete evidence for).
4. Runs 8 maker agents in parallel, each scoped to one concern (see `src/prompts/makers.js`).
   Every finding must carry file/line evidence the agent actually read.
5. Applies mechanical gates (evidence present, cross-agent duplicate merge) before spending tokens
   on verification.
6. Runs a fresh-context VERIFY agent that independently re-checks every candidate against the repo
   and the diff, explicitly applying 7 gates (evidence, relevance, reachability, existing
   protection, actionability, duplication, severity) and returning VALID / INVALID / UNCERTAIN.
7. Runs the smallest useful check-style command it can detect (`npm test`, `npm run lint`,
   `dart analyze`, `go test ./...`, `pytest`, …) so gates have execution evidence, not narration.
8. Computes risk and verdict in code from verified severities (never asserted by an agent).
9. Persists invariants and review history under `~/.pr-reviewer-agent/state/<owner>__<repo>/` so
   repeat reviews of the same repo reuse and grow project context instead of starting cold.

## GitHub Action

`.github/workflows/pr-review.yml` is a template for running this automatically on every PR in some
other repo:

1. Push this project to GitHub.
2. Copy `.github/workflows/pr-review.yml` into the target repo, and set `REVIEWER_REPO` in it to
   `sknt2024/Multi-Agent-PR-Reviewer`.
3. In the target repo's Settings → Secrets, add `ANTHROPIC_API_KEY`.
4. Open a PR in the target repo — the workflow checks it out, runs the full pipeline, and posts the
   report as a PR comment using the built-in `GITHUB_TOKEN`.

## Persistent state

State lives outside any reviewed repo, under `~/.pr-reviewer-agent/state/<owner>__<repo>/`:

- `invariants.json` — project rules discovered so far, merged (never silently overwritten) across
  reviews
- `context.md` — last-known architecture/language summary
- `review-history.md` — one line per PR reviewed
- `checkpoints/pr-<n>.json` — full result for the last commit reviewed on each PR, used to skip
  re-running when `gh` reports no new commits (override with `--force`)

Override the location with `--state-dir`.
