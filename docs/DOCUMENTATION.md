# PR Reviewer Agent — Detailed Documentation

This document is the deep technical reference for the project. For a quick start, see the
top-level [`README.md`](../README.md). For a high-level, non-technical overview, see
`docs/PR_Reviewer_Agent_Context.pdf`.

## Contents

1. [Goals & Design Principles](#1-goals--design-principles)
2. [System Architecture](#2-system-architecture)
3. [Module Reference](#3-module-reference)
4. [Data Contracts (JSON Schemas)](#4-data-contracts-json-schemas)
5. [The Maker Agents](#5-the-maker-agents)
6. [The VERIFY Agent & Gates](#6-the-verify-agent--gates)
7. [Risk & Verdict Computation](#7-risk--verdict-computation)
8. [Persistent State Model](#8-persistent-state-model)
9. [CLI Reference](#9-cli-reference)
10. [GitHub Action Setup](#10-github-action-setup)
11. [Extending the System](#11-extending-the-system)
12. [Design Tradeoffs & Known Limitations](#12-design-tradeoffs--known-limitations)
13. [Validation Run](#13-validation-run)
14. [Roadmap](#14-roadmap)

---

## 1. Goals & Design Principles

The project implements a "maker/checker" PR review pipeline: several specialized reviewer agents
independently propose candidate findings against a real, checked-out copy of a PR's branch, and a
separate agent with **fresh context** re-derives and verifies every claim before it is reported.
Nothing reaches the final report on the strength of an agent's self-reported confidence alone.

Non-negotiable principles baked into the implementation:

- **Repository is the source of truth.** Every agent has `Read`/`Grep`/`Glob`/`Bash` access to the
  actual checked-out PR branch, not just the diff text. Findings must cite evidence the agent
  actually read.
- **Maker ≠ checker.** The 8 specialist agents (`src/prompts/makers.js`) never see each other's
  output, and the VERIFY agent (`src/prompts/verify.js`) runs as a brand-new SDK session with no
  shared conversation history — it re-derives everything from the repo and diff itself.
- **Gates are computed, not narrated.** Anything that can be decided mechanically (evidence
  present, cross-agent duplicates, exit codes of real commands) is decided in plain code
  (`src/gates.js`, `src/riskCalc.js`), not asserted by an LLM.
- **Small, high-confidence output over volume.** Every agent's system prompt explicitly says to
  prefer zero findings over weak ones.

## 2. System Architecture

```
CLI (bin/pr-review.js)
  │
  ▼
orchestrator.runReview()                              (src/orchestrator.js)
  │
  ├─ 1. gh.getPrMetadata / gh.getPrDiff                 (src/github/gh.js)
  ├─ 2. checkpoint check (skip if head SHA unchanged, unless --force)
  ├─ 3. gh.checkoutPr → temp clone at PR head            (or --local-dir)
  ├─ 4. discovery agent (1x)                             (src/prompts/discovery.js)
  ├─ 5. invariants merged into persistent state           (src/state/store.js)
  ├─ 6. 8x maker agents, run in parallel via Promise.all   (src/prompts/makers.js)
  ├─    ⤷ if ALL 8 fail (e.g. no Claude auth), abort here — no report generated or posted
  ├─ 7. applyMechanicalGates()                            (src/gates.js)
  ├─ 8. VERIFY agent (1x, fresh context)                   (src/prompts/verify.js)
  ├─ 9. runVerificationCommands()                          (src/verify/runCommands.js)
  ├─ 10. computeVerdict()                                  (src/riskCalc.js)
  ├─ 11. synthesis agent (1x, no tools — prose only)        (src/prompts/synthesis.js)
  ├─ 12. formatReport()                                    (src/report/format.js)
  └─ 13. saveCheckpoint() + appendReviewHistory()           (src/state/store.js)
  │
  ▼
Markdown report → stdout / --out file / gh pr comment (--post)
```

Every "agent" call is a single, independent [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
`query()` session (`src/agents/runAgent.js`) — effectively a headless Claude Code run scoped to one
prompt, with tool access restricted to read-only operations (`Read`, `Grep`, `Glob`, `Bash` — never
`Edit`/`Write`), and forced structured output via `outputFormat: { type: 'json_schema', schema }`.
No agent shares conversation state with another; each is a fresh session, which is what makes the
verify step a genuine independent check rather than the same context re-asserting itself.

## 3. Module Reference

| Module | Responsibility |
|---|---|
| `bin/pr-review.js` | CLI entry point: arg parsing, calls `runReview`, prints/writes/posts the report. |
| `src/orchestrator.js` | The pipeline itself — owns ordering, parallelism, and wiring every stage together. Aborts (throws) rather than computing a verdict if every maker agent fails, so total agent-infrastructure failure can't silently resolve to `APPROVE` (see §12). |
| `src/github/gh.js` | All GitHub I/O via the `gh` CLI (`execFile`, never a shell string — no injection risk). PR URL/repo parsing, metadata, diff, clone+checkout, comment posting. |
| `src/agents/runAgent.js` | Thin wrapper around `query()` from the Claude Agent SDK. Runs one session to completion, returns `{ ok, output, error, costUsd, numTurns }`. Catches SDK-thrown errors (e.g. max-turns) instead of letting them crash the process. |
| `src/schemas.js` | JSON Schemas enforced on every agent's structured output — the wire contract between agents and the orchestrator. |
| `src/prompts/shared.js` | `COMMON_RULES` appended to every maker agent's system prompt, and `buildPrContextPacket()` which assembles the shared PR/repo context block every agent receives. |
| `src/prompts/discovery.js` | System prompt for the context-discovery agent. |
| `src/prompts/makers.js` | The 8 maker agent role definitions (system prompt per role). |
| `src/prompts/verify.js` | System prompt for the fresh-context VERIFY agent, including the GATE1–GATE7 checklist. |
| `src/prompts/synthesis.js` | System prompt for the no-tool-access synthesis step that writes the Summary/Positive Changes prose. |
| `src/gates.js` | Mechanical (code, not LLM) pre-filtering: evidence presence, cross-agent duplicate merge. |
| `src/riskCalc.js` | Computes final `risk` + `verdict` from verified finding severities. Pure function, fully deterministic. |
| `src/report/format.js` | Deterministic Markdown formatter for the final report. No LLM call. |
| `src/state/store.js` | Persistent review knowledge on disk: invariants, context, review history, per-PR checkpoints. |
| `src/verify/runCommands.js` | Detects and runs the smallest useful check command (`npm test`, `dart analyze`, `go test ./...`, `pytest`, …) with a bounded timeout, so the "Verification" section has real exit-code evidence. |

## 4. Data Contracts (JSON Schemas)

All schemas live in `src/schemas.js` and are passed as `outputFormat: { type: 'json_schema', schema }`
to the SDK, which forces the agent's final turn through a schema-validated structured-output tool
call — the orchestrator never parses free-form text out of a response.

- `AGENT_FINDINGS_SCHEMA` — used by all 8 maker agents. `{ agent: string, findings: Finding[] }`
  where every `Finding` has `id, title, category, severity, confidence, file, start_line, end_line,
  problem, evidence, impact, recommendation` — all fields required, no optional fields (see §12 for
  why every schema in this project avoids optional properties).
- `VERIFY_SCHEMA` — `{ verdicts: Verdict[] }` where each `Verdict` has `id, verdict, reason,
  duplicate_of, severity_override, confidence_override` (the last three are nullable, not omitted).
- `DISCOVERY_SCHEMA` — languages, frameworks, architecture, package_manager, intent, risk_areas,
  invariants (each with `id, rule, source`).
- `SYNTHESIS_SCHEMA` — `{ summary: string, positives: string }` only.

## 5. The Maker Agents

Defined in `src/prompts/makers.js`. Each receives the same `buildPrContextPacket()` (PR title/body,
diff, changed files, discovered invariants) plus `COMMON_RULES`, and runs with `Read/Grep/Glob/Bash`
access to the checked-out PR branch (`maxTurns: 25`).

| Key | Title | Focus |
|---|---|---|
| `bug` | Bug Hunter | Correctness: conditions, null handling, races, state transitions, error handling, resource lifecycle. |
| `security` | Security | AuthN/AuthZ, injection, SSRF, secrets, unsafe deserialization, data exposure — traced attack-surface → entry point → data flow → impact. |
| `performance` | Performance | Algorithmic complexity, N+1 queries, blocking ops, unbounded concurrency/memory, missing timeouts. |
| `architecture` | Architecture | Layer boundaries, dependency direction, coupling — only when it creates measurable risk, not style preference. |
| `testing` | Testing | What changed, what regressed, what's covered vs. not — reads the actual test files, doesn't assume. |
| `api_db` | API / Database | HTTP semantics, validation, backward compatibility; SQL/Mongo index and query-pattern checks. |
| `framework` | Framework Specialist | Detects Flutter/Node/React usage from the repo itself and applies only the relevant checklist. |
| `devops` | DevOps / CI | Dockerfiles, GitHub Actions, migrations, rollback safety — things that break deploys even when tests pass. |

Each maker agent's system prompt explicitly tells it not to report an issue if surrounding code
already prevents it, not to report pre-existing issues outside the PR's blast radius, and to prefer
an empty `findings` array over a weak one.

## 6. The VERIFY Agent & Gates

Two layers of gating, matching the "gates are computed, not narrated" principle:

**Mechanical gates (`src/gates.js`)** — run in plain code before any verify tokens are spent:
- `GATE1_EVIDENCE`: reject findings with empty `evidence`/`problem`/`file`.
- `GATE6_DUPLICATION`: merge findings from different agents that share a file, overlapping line
  range (±3 lines slack), and a similar normalized title (≥60% shared significant words).

**Semantic gates (VERIFY agent, `src/prompts/verify.js`)** — a brand-new SDK session (no shared
history with the makers) that re-derives every remaining candidate from the repo, applying:

| Gate | Question |
|---|---|
| GATE1 Evidence | Is there concrete evidence, or speculation? |
| GATE2 Relevance | Was this introduced or materially affected by the PR? |
| GATE3 Reachability | Can the code actually execute as described? |
| GATE4 Existing protection | Does surrounding code already prevent it? |
| GATE5 Actionability | Is there a concrete fix? |
| GATE6 Duplication | Same underlying issue as another candidate? |
| GATE7 Severity | Is the claimed severity justified by actual impact? |

Every candidate gets exactly one of `VALID` / `INVALID` / `UNCERTAIN`. If the VERIFY agent's
response omits a verdict for some candidate id (shouldn't happen given the schema, but handled
defensively), the orchestrator treats it as `UNCERTAIN` rather than silently dropping it
(`src/orchestrator.js`, the "seen" reconciliation loop after the verify call).

## 7. Risk & Verdict Computation

Pure function in `src/riskCalc.js`, evaluated only over `VALID` findings:

| Condition | Risk | Verdict |
|---|---|---|
| Any `CRITICAL` | CRITICAL | REQUEST CHANGES |
| Any `HIGH` | HIGH | REQUEST CHANGES |
| ≥3 `MEDIUM` | HIGH | REQUEST CHANGES (combined risk) |
| Any `MEDIUM` | MEDIUM | APPROVE WITH COMMENTS |
| Any `LOW`/`INFO`, no higher | LOW | APPROVE WITH COMMENTS |
| No verified findings | LOW | APPROVE |

## 8. Persistent State Model

Managed by `src/state/store.js`, rooted at `~/.pr-reviewer-agent/state/<owner>__<repo>/` by default
(override with `--state-dir`). Deliberately **outside** the reviewed repo's working tree — this tool
does not own that repository and should not write files into someone else's checkout unless asked.

```
<state-root>/<owner>__<repo>/
  invariants.json        # merged by id across every review — never silently overwritten
  context.md              # last-known architecture/language summary
  review-history.md       # one appended line per PR reviewed
  checkpoints/
    pr-<number>.json      # { headRefOid, verdict, risk, report, stats } for the last commit reviewed
  decisions/               # reserved for future architectural-decision records
```

**Resume/cache behavior:** before doing any agent work, the orchestrator compares the PR's current
`headRefOid` (from `gh pr view --json headRefOid`) against the cached checkpoint. If they match, the
cached report is returned immediately (no agents run) unless `--force` is passed. This means posting
the same reviewed commit twice, or re-running in CI on an unrelated event, is nearly free.

## 9. CLI Reference

```
pr-review <github-pr-url> [options]
pr-review --repo owner/repo --pr 123 [options]

--model <name>        Claude model to use (default: CLI default)
--out <file>           Write the markdown report to a file
--post                 Post the report as a comment on the PR (gh pr comment) — never implied, always explicit
--state-dir <dir>       Override persistent state directory
--local-dir <dir>       Review an already-checked-out local directory instead of cloning
--force                 Ignore cached checkpoint and re-run even if no new commits
--keep-clone            Don't delete the temporary clone after the review
--verify-limit <n>      Max number of test/lint/typecheck commands to run (default: 3)
```

## 10. GitHub Action Setup

`.github/workflows/pr-review.yml` is a **template**, meant to be copied into the repository you want
reviewed:

1. Push this project to GitHub.
2. In the copied workflow file, set `REVIEWER_REPO` to `<your-user>/Multi-Agent-PR-Reviewer`.
3. Add an `ANTHROPIC_API_KEY` secret to the target repo (required — there's no interactive `claude
   login` in CI).
4. The workflow checks out the target repo at the PR head SHA, checks out this tool into a sibling
   directory, `npm ci`s it, then runs `pr-review.js --local-dir <target checkout> --post` using the
   Action's own `GITHUB_TOKEN` for `gh` calls. Note it always runs the reviewer from `REVIEWER_REF`
   (`main` by default) — a fix or prompt change only takes effect in CI once it's merged there, not
   while it's still sitting on an open PR branch.

**"Template" is documentation intent, not an enforced restriction.** Committing this file to
`.github/workflows/` in *this* repo's own `main` (as happened here — see §13) makes GitHub run it on
this repo's own pull requests too; GitHub doesn't read the header comment. If you don't want that,
either don't commit the file to this repo's own default branch, or treat it as a real deployment and
add `ANTHROPIC_API_KEY` here as well (`gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>`) so it
actually works instead of failing closed on every PR (§12 covers what happens when it fails without
the fix in §12/§13 applied).

**Branch protection on `main`** is documented separately in
[`docs/BRANCH_PROTECTION.md`](BRANCH_PROTECTION.md) — what's applied, why, and how to change it.

## 11. Extending the System

**Add a new maker agent:** append an entry to `MAKER_AGENTS` in `src/prompts/makers.js` with a
`key`, `name`, `title`, and `systemPrompt`. It's automatically picked up by
`Promise.all(MAKER_AGENTS.map(...))` in `src/orchestrator.js` — no other wiring needed. Keep the
system prompt scoped to one concern; broad generalist prompts produce lower-signal findings.

**Add a new mechanical gate:** extend `applyMechanicalGates()` in `src/gates.js`. Keep it a pure
function over `agentResults → { candidates, rejected }` so it stays testable without hitting the
network.

**Change verdict thresholds:** all threshold logic lives in `computeVerdict()`
(`src/riskCalc.js`) — a single pure function, safe to unit test in isolation.

**Support another host (GitLab/Bitbucket):** the only GitHub-specific module is
`src/github/gh.js`. Everything downstream of `getPrMetadata`/`getPrDiff`/`checkoutPr`/`postComment`
is host-agnostic; a `src/gitlab/glab.js` with the same four functions would let the orchestrator
work unchanged.

## 12. Design Tradeoffs & Known Limitations

- **Cost/latency:** one full review spends 10 Claude Agent SDK sessions (1 discovery + 8 makers +
  1 verify) plus 1 lightweight synthesis call, each a multi-turn agentic loop with real tool calls.
  This is deliberately expensive relative to a single-prompt review — the tradeoff for
  independently-verified, low-slop findings.
- **Bash tool exposure:** maker/verify agents run with `permissionMode: 'bypassPermissions'` and
  `Bash` access so they can run `git log`, `git blame`, grep across the repo, etc. without prompting.
  This is scoped to a disposable temp clone (`os.tmpdir()/pr-review-...`, deleted after the run
  unless `--keep-clone`) — never the user's own working directory — so a misbehaving agent's blast
  radius is contained to a throwaway checkout.
- **Strict JSON Schema + `additionalProperties: false` requires every property to be `required`.**
  Optional-looking fields (e.g. `VERIFY_SCHEMA`'s `duplicate_of`, `severity_override`) are modeled
  as required-but-nullable (`type: ["string", "null"]`) rather than omittable — omittable optional
  fields under `additionalProperties: false` risk schema-validation failures with the SDK's
  structured-output mode. Discovered during initial testing (see §13) and fixed everywhere in
  `src/schemas.js`.
- **The Claude Agent SDK's `query()` iterator throws on some terminal conditions (e.g. max-turns
  exhaustion) instead of yielding an `SDKResultError` message,** despite the type definitions
  modeling both success and error as `result`-type messages. `runAgent()` wraps the iteration in
  `try/catch` so a single agent's failure degrades to `{ ok: false }` (and the orchestrator falls
  back to reasonable defaults) instead of crashing the whole review. Also discovered during initial
  testing.
- **Cache key is `headRefOid` only.** If you change a maker agent's prompt or a schema and re-run
  against a PR whose head commit hasn't changed, you'll get the stale cached report unless you pass
  `--force`. There's no cache-busting on tool/prompt version yet (see Roadmap).
- **`--post` has no additional interactive confirmation inside the script** — passing the flag on
  a given invocation is treated as the user's explicit authorization for that run, consistent with
  how any other one-shot CLI flag works. It is never implied by any other flag or by CI defaults;
  the Action template only posts because the repo owner explicitly added that workflow file.
- **No test suite yet for the orchestration logic itself** (`gates.js`, `riskCalc.js`,
  `report/format.js` are all pure functions and would be cheap to unit test — see Roadmap).
- **Total agent failure previously resolved to a false `APPROVE`.** §7's verdict table treats zero
  verified findings as `APPROVE` — correct when 8 makers genuinely found nothing, wrong when all 8
  never ran at all. Found during CI testing (§13): with no `ANTHROPIC_API_KEY` set, every maker
  agent failed with "Not logged in," `candidates.length` was `0`, and the orchestrator fell through
  to computing (and, with `--post`, actually posting) `APPROVE` — a confident-looking review that
  never happened. Fixed in `src/orchestrator.js`: if `successfulMakers.length === 0` after the maker
  fan-out, the run throws before generating or posting any report. The threshold is deliberately
  "all failed," not a majority — a partial failure (e.g. 1 of 8 makers down) still produces a
  legitimate, if narrower, review and shouldn't abort.

## 13. Validation Run

The pipeline was run end-to-end against a real open PR
(`ayush488-glitch/genesis-kit#3` — "scaffold.sh: fix argument parsing") with `--post` **not** set:

- All 10 agent sessions completed; 8 makers returned 5 candidate findings total.
- Mechanical gates passed all 5 through (no exact duplicates that run).
- The VERIFY agent returned 2 `VALID` and 3 `INVALID` — i.e. it rejected the majority of
  maker-proposed candidates, which is the intended behavior of an independent checker.
- The one `MEDIUM` finding that survived was a genuine, reproducible bug: the agent ran
  `bash -x` against the patched script with the PR's own documented invocation and showed
  `PROJECT` being set to the literal flag string `--cheap-model` instead of falling back to the
  target's basename — with the exact line numbers, a shell trace, and a concrete one-line fix.
- Checkpointing was verified separately: a second run against the same commit returned in ~1.5s
  from `~/.pr-reviewer-agent/state/.../checkpoints/pr-3.json` instead of re-running any agents.

Two real bugs were caught and fixed during this validation (see §12): the nullable-optional-field
schema issue, and the uncaught max-turns exception in `runAgent.js`.

### Session 2 — `--post`, branch protection, and the false-approve bug (2026-08-19)

- Confirmed the Claude Agent SDK authenticates via the local `claude` OAuth login with no
  `ANTHROPIC_API_KEY` set, using an isolated minimal `query()` call before trusting the full
  pipeline to it.
- Ran the full pipeline against a live throwaway PR in this tool's own repo, with a deliberately
  injected off-by-one bug (`slice(0, max - 1)` instead of `slice(0, max)`). Verdict `APPROVE WITH
  COMMENTS`; the bug was caught with executed evidence (the VERIFY agent ran the function against a
  10-element array and reported actual vs. expected output), and an unrelated candidate was
  correctly rejected by VERIFY.
- Tested `--post` end-to-end: the CLI's comment (authored by the invoking `gh` user, not a bot)
  landed on the PR with the full report, confirmed via the GitHub API rather than trusting the
  CLI's own "Posted." log line.
- While checking that comment, found a second, unrelated `github-actions[bot]` comment on the same
  PR claiming `APPROVE` with `Agents executed: 9` — this tool's own copy of
  `.github/workflows/pr-review.yml` had auto-run (see §10) with no `ANTHROPIC_API_KEY` configured on
  this repo, every agent failed with "Not logged in," and the false-approve bug (§12) posted anyway.
- Fixed the bug in `src/orchestrator.js`, verified the fix locally first (forced total failure with
  `--model bogus-model-does-not-exist`; process exited `1`, no report file written), then verified
  it live in CI on a fresh PR: the same no-`ANTHROPIC_API_KEY` conditions now produce a workflow run
  with conclusion `failure` and **zero** PR comments, instead of a `success` run with a false
  `APPROVE`.
- Applied branch protection to `main` (PR required, no admin bypass, no force-push/deletion) —
  see `docs/BRANCH_PROTECTION.md`.
- As of this writing, `ANTHROPIC_API_KEY` is still not set on this repo's own secrets, so its own
  workflow will keep failing closed (correctly) until that's added.

## 14. Roadmap

- Unit tests for `gates.js`, `riskCalc.js`, `report/format.js` (pure functions, no network needed).
- Cache key that also accounts for a "pipeline version" so prompt/schema changes invalidate stale
  checkpoints automatically.
- Inline PR review comments (via `gh api` on specific diff lines) as an alternative to a single
  summary comment, once GitHub's suggested-line-comment semantics are wired up.
- GitLab/Bitbucket adapters behind the same four-function interface described in §11.
- Publish to npm so the GitHub Action template doesn't need a separate checkout step.
- Add `ANTHROPIC_API_KEY` to this repo's own secrets so its own copy of the workflow (§10) reviews
  its own PRs instead of failing closed — or explicitly decide not to run it here at all.
