# Branch Protection — `main`

`main` is protected via the GitHub classic branch protection API
(`repos/sknt2024/Multi-Agent-PR-Reviewer/branches/main/protection`). Settings applied:

| Setting | Value | Effect |
|---|---|---|
| Require a pull request before merging | on, 0 required approvals | All changes to `main`, including the maintainer's own, must go through a PR — no direct pushes. 0 approvals because this is currently a solo-maintainer repo; raise `required_approving_review_count` once there are other reviewers. |
| Enforce for admins | on | No bypass — repo admins are held to the same PR-only rule as everyone else. |
| Allow force pushes | off | History on `main` can't be rewritten. |
| Allow deletions | off | `main` can't be deleted. |
| Require conversation resolution before merging | on | Open PR review threads must be resolved before merge. |
| Required status checks | none | `.github/workflows/pr-review.yml` does run on this repo's own PRs (see `docs/DOCUMENTATION.md` §10 — committing the file to `main` is enough to trigger it here too, "template" or not), but it isn't wired into `required_status_checks` yet. Do that once `ANTHROPIC_API_KEY` is set and the workflow is reliable enough to gate merges on. |
| Required linear history | off | Merge commits are allowed. |

## Why

Previously `main` had no protection at all — the initial push and a follow-up doc fix were both
made directly to `main`. This closes that gap and forces the PR-based workflow the reviewer tool
itself is built around (`gh pr checkout` + review), including for the maintainer.

## Changing it

The exact payload applied is checked in at
[`docs/branch-protection-ruleset.json`](branch-protection-ruleset.json). Edit that file and re-apply
it (or use the GitHub UI under **Settings → Branches**). Run this from the repository root — the
`--input` path below is relative, not absolute — or use `git rev-parse --show-toplevel` as shown to
make it work from anywhere:

```bash
gh api --method PUT repos/sknt2024/Multi-Agent-PR-Reviewer/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input "$(git rev-parse --show-toplevel)/docs/branch-protection-ruleset.json"
```

Note `-f`/`-F` flags on `gh api` can't express a JSON `null` (they send the literal string
`"null"`, which the branch-protection endpoint rejects) — that's why this is a real JSON file passed
via `--input`, rather than inline `-f`/`-F` flags, for the two fields that need `null`
(`required_status_checks`, `restrictions`).
