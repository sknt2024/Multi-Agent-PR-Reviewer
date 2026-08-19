#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

import { parsePrTarget, postComment } from "../src/github/gh.js";
import { runReview } from "../src/orchestrator.js";
import { defaultStateRoot } from "../src/state/store.js";

const HELP = `pr-review — multi-agent PR reviewer

Usage:
  pr-review <github-pr-url> [options]
  pr-review --repo owner/repo --pr 123 [options]

Options:
  --model <name>        Claude model to use (default: CLI default)
  --out <file>           Write the markdown report to a file
  --post                 Post the report as a comment on the PR (gh pr comment)
  --state-dir <dir>       Override persistent state directory (default: ~/.pr-reviewer-agent/state)
  --local-dir <dir>       Review an already-checked-out local directory instead of cloning
  --force                 Ignore cached checkpoint and re-run even if no new commits
  --keep-clone            Don't delete the temporary clone after the review
  --verify-limit <n>      Max number of test/lint/typecheck commands to run (default: 3)
  -h, --help              Show this help
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      model: { type: "string" },
      out: { type: "string" },
      post: { type: "boolean", default: false },
      "state-dir": { type: "string" },
      "local-dir": { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      force: { type: "boolean", default: false },
      "keep-clone": { type: "boolean", default: false },
      "verify-limit": { type: "string", default: "3" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || (!positionals[0] && !(values.repo && values.pr))) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const target = parsePrTarget(
    positionals[0] ? { url: positionals[0] } : { repo: values.repo, number: values.pr }
  );

  const { report, fromCache } = await runReview({
    target,
    model: values.model,
    stateRoot: values["state-dir"] || defaultStateRoot(),
    localDir: values["local-dir"],
    force: values.force,
    keepClone: values["keep-clone"],
    verifyCommandLimit: Number(values["verify-limit"]),
  });

  process.stdout.write(`\n${report}\n`);
  if (fromCache) process.stderr.write("[pr-review] (served from cache — pass --force to re-run)\n");

  if (values.out) {
    await writeFile(values.out, report);
    process.stderr.write(`[pr-review] Report written to ${values.out}\n`);
  }

  if (values.post) {
    const tmpOut = values.out || `.pr-review-${target.number}.md`;
    if (!values.out) await writeFile(tmpOut, report);
    process.stderr.write(`[pr-review] Posting comment to ${target.fullRepo}#${target.number}...\n`);
    await postComment(target, tmpOut);
    process.stderr.write("[pr-review] Posted.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[pr-review] ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});
