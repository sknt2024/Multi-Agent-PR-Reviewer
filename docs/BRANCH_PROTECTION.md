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

Edit and re-run the same API call (or use the GitHub UI under **Settings → Branches**):

```bash
gh api --method PUT repos/sknt2024/Multi-Agent-PR-Reviewer/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
EOF
```

Note `-f`/`-F` flags on `gh api` can't express a JSON `null` (they send the literal string
`"null"`, which the branch-protection endpoint rejects) — use `--input -` with a heredoc for any
field that needs `null` (`required_status_checks`, `restrictions`).
