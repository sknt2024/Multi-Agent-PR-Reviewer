// Spec section 11 — "run the smallest useful verification command" so gates have evidence instead
// of narration. Intentionally conservative: only read-only/check-style commands (test/lint/
// typecheck/analyze), never build/deploy/migrate, and bounded by a timeout.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;

async function fileExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function runOne(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.slice(-MAX_OUTPUT_CHARS) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `spawn error: ${err.message}` });
    });
  });
}

async function discoverCandidates(cwd) {
  const candidates = [];

  const pkgPath = path.join(cwd, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};
      for (const name of ["test", "lint", "typecheck", "type-check"]) {
        if (scripts[name]) candidates.push({ label: `npm run ${name}`, command: "npm", args: ["run", name] });
      }
    } catch {
      // malformed package.json — skip npm-based checks, other ecosystems may still apply
    }
  }

  if (await fileExists(path.join(cwd, "pubspec.yaml"))) {
    candidates.push({ label: "dart analyze", command: "dart", args: ["analyze"] });
    candidates.push({ label: "flutter test", command: "flutter", args: ["test"] });
  }

  if (await fileExists(path.join(cwd, "go.mod"))) {
    candidates.push({ label: "go test ./...", command: "go", args: ["test", "./..."] });
  }

  if ((await fileExists(path.join(cwd, "pyproject.toml"))) || (await fileExists(path.join(cwd, "pytest.ini")))) {
    candidates.push({ label: "pytest", command: "pytest", args: ["-q"] });
  }

  return candidates;
}

/** Runs at most `limit` detected check-style commands and returns their evidence. */
export async function runVerificationCommands(cwd, { limit = 3 } = {}) {
  const candidates = await discoverCandidates(cwd);
  const results = [];
  for (const c of candidates.slice(0, limit)) {
    const { code, output } = await runOne(c.command, c.args, cwd);
    results.push({
      command: c.label,
      exitCode: code,
      result: code === 0 ? "exit code 0" : code === null ? "did not run (missing tool or timed out)" : `exit code ${code}`,
      outputTail: output,
    });
  }
  return results;
}
