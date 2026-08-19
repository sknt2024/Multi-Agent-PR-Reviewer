// Persistent review knowledge — spec section 15/16. Stored under the reviewer tool's own state
// directory (default: ~/.pr-reviewer-agent/state/<owner>__<repo>/), NOT inside the target repo's
// working tree — this tool doesn't own that repo and shouldn't write files into someone else's
// checkout without being asked to. Override with --state-dir.

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function defaultStateRoot() {
  return path.join(os.homedir(), ".pr-reviewer-agent", "state");
}

export function stateDirFor(target, root = defaultStateRoot()) {
  return path.join(root, `${target.owner}__${target.repo}`);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "checkpoints"), { recursive: true });
  await mkdir(path.join(dir, "decisions"), { recursive: true });
}

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function loadInvariants(dir) {
  return readJsonIfExists(path.join(dir, "invariants.json"), { invariants: [] });
}

/** Merge new invariants by id — never silently overwrite existing project conventions. */
export async function mergeInvariants(dir, newInvariants) {
  await ensureDir(dir);
  const existing = await loadInvariants(dir);
  const byId = new Map(existing.invariants.map((i) => [i.id, i]));
  for (const inv of newInvariants || []) {
    if (!byId.has(inv.id)) byId.set(inv.id, inv);
  }
  const merged = { invariants: [...byId.values()] };
  await writeFile(path.join(dir, "invariants.json"), JSON.stringify(merged, null, 2));
  return merged.invariants;
}

export async function saveContext(dir, discovery) {
  await ensureDir(dir);
  const body = `# Repository Context

_Last updated by pr-reviewer-agent. Not overwritten blindly — regenerated from the most recent PR review's discovery pass._

- Languages: ${(discovery.languages || []).join(", ") || "unknown"}
- Frameworks: ${(discovery.frameworks || []).join(", ") || "unknown"}
- Architecture: ${discovery.architecture || "unknown"}
- Package manager: ${discovery.package_manager || "unknown"}
`;
  await writeFile(path.join(dir, "context.md"), body);
}

export async function appendReviewHistory(dir, entry) {
  await ensureDir(dir);
  const line = `- ${entry.date} — PR #${entry.number} "${entry.title}" — ${entry.verdict} (${entry.risk}) — ${entry.verifiedCount} verified findings\n`;
  await appendFile(path.join(dir, "review-history.md"), line);
}

export async function saveCheckpoint(dir, prNumber, data) {
  await ensureDir(dir);
  await writeFile(path.join(dir, "checkpoints", `pr-${prNumber}.json`), JSON.stringify(data, null, 2));
}

export async function loadCheckpoint(dir, prNumber) {
  return readJsonIfExists(path.join(dir, "checkpoints", `pr-${prNumber}.json`), null);
}
