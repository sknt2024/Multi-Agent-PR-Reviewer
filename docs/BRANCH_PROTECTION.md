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
| Required status checks | none | This repo has no CI workflow of its own yet (`.github/workflows/pr-review.yml` is a template meant to be copied into *other* repos, not run here). Add one and wire it into `required_status_checks` if that changes. |
| Required linear history | off | Merge commits are allowed. |

## Why

Previously `main` had no protection at all — the initial push and a follow-up doc fix were both
made directly to `main`. This closes that gap and forces the PR-based workflow the reviewer tool
itself is built around (`gh pr checkout` + review), including for the maintainer.

## Changing it

The exact payload applied is checked in at
[`docs/branch-protection-ruleset.json`](branch-protection-ruleset.json). Edit that file and re-apply
it (or use the GitHub UI under **Settings → Branches**):

```bash
gh api --method PUT repos/sknt2024/Multi-Agent-PR-Reviewer/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input docs/branch-protection-ruleset.json
```

Note `-f`/`-F` flags on `gh api` can't express a JSON `null` (they send the literal string
`"null"`, which the branch-protection endpoint rejects) — that's why this is a real JSON file passed
via `--input`, rather than inline `-f`/`-F` flags, for the two fields that need `null`
(`required_status_checks`, `restrictions`).
