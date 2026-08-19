import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 64; // 64MB, diffs can be large

async function gh(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: MAX_BUFFER,
      cwd: opts.cwd,
      env: process.env,
    });
    return stdout;
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || err.message}`);
  }
}

/**
 * Accepts either a full PR URL (https://github.com/owner/repo/pull/123)
 * or explicit { repo: "owner/repo", number } fields.
 */
export function parsePrTarget({ url, repo, number }) {
  if (url) {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (!m) throw new Error(`Could not parse a PR URL from: ${url}`);
    return { owner: m[1], repo: m[2], fullRepo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  }
  if (!repo || !number) {
    throw new Error("Provide either a PR URL, or both --repo and --pr");
  }
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`--repo must be "owner/repo", got: ${repo}`);
  return { owner, repo: repoName, fullRepo: repo, number: Number(number) };
}

const PR_FIELDS = [
  "number",
  "title",
  "body",
  "url",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "additions",
  "deletions",
  "changedFiles",
  "isCrossRepository",
  "mergeable",
  "state",
  "files",
].join(",");

export async function getPrMetadata(target) {
  const out = await gh(["pr", "view", String(target.number), "--repo", target.fullRepo, "--json", PR_FIELDS]);
  return JSON.parse(out);
}

export async function getPrDiff(target) {
  return gh(["pr", "diff", String(target.number), "--repo", target.fullRepo]);
}

export async function checkoutPr(target, dir) {
  await gh(["repo", "clone", target.fullRepo, dir, "--", "--quiet"]);
  await gh(["pr", "checkout", String(target.number), "--repo", target.fullRepo], { cwd: dir });
  return dir;
}

export async function postComment(target, bodyFile) {
  return gh(["pr", "comment", String(target.number), "--repo", target.fullRepo, "--body-file", bodyFile]);
}

export async function currentGhUser() {
  const out = await gh(["api", "user", "--jq", ".login"]);
  return out.trim();
}
