import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as gh from "./github/gh.js";
import { runAgent } from "./agents/runAgent.js";
import { MAKER_AGENTS } from "./prompts/makers.js";
import { COMMON_RULES, buildPrContextPacket } from "./prompts/shared.js";
import { DISCOVERY_SYSTEM_PROMPT } from "./prompts/discovery.js";
import { VERIFY_SYSTEM_PROMPT } from "./prompts/verify.js";
import { SYNTHESIS_SYSTEM_PROMPT } from "./prompts/synthesis.js";
import { AGENT_FINDINGS_SCHEMA, DISCOVERY_SCHEMA, VERIFY_SCHEMA, SYNTHESIS_SCHEMA } from "./schemas.js";
import { applyMechanicalGates } from "./gates.js";
import { computeVerdict } from "./riskCalc.js";
import { runVerificationCommands } from "./verify/runCommands.js";
import { formatReport } from "./report/format.js";
import {
  stateDirFor,
  loadInvariants,
  mergeInvariants,
  saveContext,
  appendReviewHistory,
  saveCheckpoint,
  loadCheckpoint,
} from "./state/store.js";

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_SUFFIX_RE = /\.(test|spec)\.[a-z]+$/i;

function log(msg) {
  process.stderr.write(`[pr-review] ${msg}\n`);
}

function isTestFile(p) {
  return TEST_FILE_RE.test(p) || TEST_SUFFIX_RE.test(p);
}

export async function runReview({
  target,
  model,
  stateRoot,
  localDir,
  force = false,
  keepClone = false,
  verifyCommandLimit = 3,
}) {
  const stateDir = stateDirFor(target, stateRoot);

  log(`Fetching PR metadata for ${target.fullRepo}#${target.number}`);
  const pr = await gh.getPrMetadata(target);
  const diff = await gh.getPrDiff(target);
  const changedFiles = (pr.files || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));

  const cached = await loadCheckpoint(stateDir, target.number);
  if (cached && cached.headRefOid === pr.headRefOid && !force) {
    log(`No new commits since last review (${pr.headRefOid.slice(0, 8)}) — reusing cached report. Pass --force to re-run.`);
    return { report: cached.report, verdict: cached.verdict, risk: cached.risk, fromCache: true, target, pr };
  }

  let checkoutDir = localDir;
  let cleanupDir = null;
  if (!checkoutDir) {
    checkoutDir = await mkdtemp(path.join(os.tmpdir(), `pr-review-${target.owner}-${target.repo}-${target.number}-`));
    cleanupDir = checkoutDir;
    log(`Cloning ${target.fullRepo} and checking out PR #${target.number} into ${checkoutDir}`);
    await gh.checkoutPr(target, checkoutDir);
  }

  try {
    const priorInvariants = await loadInvariants(stateDir);

    log("Running discovery agent");
    const discoveryRun = await runAgent({
      label: "discovery",
      systemPrompt: DISCOVERY_SYSTEM_PROMPT,
      prompt: `PR title: ${pr.title}\n\nPR description:\n${pr.body || "(none)"}\n\nChanged files:\n${changedFiles.map((f) => `- ${f.path}`).join("\n")}\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\`\n\nPreviously known invariants for this repo:\n${JSON.stringify(priorInvariants.invariants, null, 2)}`,
      schema: DISCOVERY_SCHEMA,
      cwd: checkoutDir,
      model,
      maxTurns: 15,
    });

    const discovery = discoveryRun.ok
      ? discoveryRun.output
      : { languages: [], frameworks: [], architecture: "unknown", intent: pr.title, risk_areas: [], invariants: [] };
    if (!discoveryRun.ok) log(`WARNING: discovery agent failed (${discoveryRun.error}); continuing with minimal context`);

    const mergedInvariants = await mergeInvariants(stateDir, discovery.invariants);
    await saveContext(stateDir, discovery);

    const contextPacket = buildPrContextPacket({ pr, diff, changedFiles, discovery, invariants: mergedInvariants });

    log(`Running ${MAKER_AGENTS.length} maker agents in parallel`);
    const makerRuns = await Promise.all(
      MAKER_AGENTS.map(async (agent) => {
        const result = await runAgent({
          label: agent.name,
          systemPrompt: `${agent.systemPrompt}\n\n${COMMON_RULES}`,
          prompt: contextPacket,
          schema: AGENT_FINDINGS_SCHEMA,
          cwd: checkoutDir,
          model,
          maxTurns: 25,
        });
        if (!result.ok) log(`WARNING: agent "${agent.name}" failed: ${result.error}`);
        else log(`Agent "${agent.name}" returned ${result.output.findings.length} candidate finding(s)`);
        return { ...result, agentKey: agent.key };
      })
    );

    const successfulMakers = makerRuns.filter((r) => r.ok);
    if (successfulMakers.length === 0) {
      const errors = makerRuns.map((r) => `${r.label}: ${r.error}`).join("; ");
      throw new Error(
        `All ${makerRuns.length} maker agents failed — aborting without a verdict (a review can't be computed from zero real findings). Errors: ${errors}`
      );
    }

    const { candidates, rejected: mechanicallyRejected } = applyMechanicalGates(makerRuns);
    log(`${candidates.length} candidate finding(s) survived mechanical gates (${mechanicallyRejected.length} rejected/merged)`);

    let verifiedFindings = [];
    let uncertainFindings = [];
    let verifyRejected = [];

    if (candidates.length > 0) {
      log("Running fresh-context VERIFY agent");
      const verifyPrompt = `${contextPacket}\n\n## Candidate Findings To Verify (from independent maker agents — do not trust their confidence)\n\`\`\`json\n${JSON.stringify(
        candidates.map(({ id, title, category, severity, confidence, file, start_line, end_line, problem, evidence, impact, recommendation }) => ({
          id, title, category, severity, confidence, file, start_line, end_line, problem, evidence, impact, recommendation,
        })),
        null,
        2
      )}\n\`\`\``;

      const verifyRun = await runAgent({
        label: "verify",
        systemPrompt: VERIFY_SYSTEM_PROMPT,
        prompt: verifyPrompt,
        schema: VERIFY_SCHEMA,
        cwd: checkoutDir,
        model,
        maxTurns: 35,
      });

      if (!verifyRun.ok) {
        log(`WARNING: VERIFY agent failed (${verifyRun.error}) — treating all candidates as UNCERTAIN`);
        uncertainFindings = candidates.map((c) => ({ ...c, verifyReason: "Verifier unavailable" }));
      } else {
        const byId = new Map(candidates.map((c) => [c.id, c]));
        for (const v of verifyRun.output.verdicts) {
          const candidate = byId.get(v.id);
          if (!candidate) continue;
          const resolved = {
            ...candidate,
            severity: v.severity_override || candidate.severity,
            confidence: v.confidence_override || candidate.confidence,
            verifyReason: v.reason,
            duplicateOf: v.duplicate_of || null,
          };
          if (v.verdict === "VALID") verifiedFindings.push(resolved);
          else if (v.verdict === "UNCERTAIN") uncertainFindings.push(resolved);
          else verifyRejected.push(resolved);
        }
        // Any candidate the verifier didn't address at all is treated as uncertain, not silently dropped.
        for (const c of candidates) {
          const seen = verifiedFindings.some((f) => f.id === c.id) || uncertainFindings.some((f) => f.id === c.id) || verifyRejected.some((f) => f.id === c.id);
          if (!seen) uncertainFindings.push({ ...c, verifyReason: "VERIFY agent did not return a verdict for this id" });
        }
      }
    }

    log(`Verified: ${verifiedFindings.length}, uncertain: ${uncertainFindings.length}, rejected-by-verify: ${verifyRejected.length}`);

    const verificationCommands = (await runVerificationCommands(checkoutDir, { limit: verifyCommandLimit })).map((r) => ({
      command: r.command,
      result: r.result,
    }));

    const { risk, verdict, counts } = computeVerdict(verifiedFindings);

    const testTouchedFiles = changedFiles.map((f) => f.path).filter(isTestFile);
    const missingCoverageFindings = verifiedFindings.filter((f) => f.sourceAgent === "testing");

    const synthesisPrompt = `Verdict: ${verdict}\nRisk: ${risk}\nSeverity counts: ${JSON.stringify(counts)}\n\nVerified findings (title — severity):\n${
      verifiedFindings.map((f) => `- ${f.title} — ${f.severity}`).join("\n") || "(none)"
    }\n\nPR diff stats: +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} files.\n\nTest files touched by this PR: ${testTouchedFiles.join(", ") || "(none)"}`;

    log("Running synthesis step (summary + positives, no tool access)");
    const synthesisRun = await runAgent({
      label: "synthesis",
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      prompt: synthesisPrompt,
      schema: SYNTHESIS_SCHEMA,
      cwd: checkoutDir,
      model,
      maxTurns: 6,
      tools: [],
    });
    const synthesis = synthesisRun.ok
      ? synthesisRun.output
      : { summary: `${verdict} — ${verifiedFindings.length} verified finding(s) (${risk} risk).`, positives: "" };

    const stats = {
      agentsExecuted: MAKER_AGENTS.length + 1 /* discovery */ + (candidates.length > 0 ? 1 : 0) /* verify */,
      candidateFindings: candidates.length,
      verifiedFindings: verifiedFindings.length,
      rejectedFindings: mechanicallyRejected.length + verifyRejected.length,
      uncertainFindings: uncertainFindings.length,
      severityCounts: counts,
    };

    const reportState = {
      pr,
      verdict,
      risk,
      summary: synthesis.summary,
      verifiedFindings,
      testAssessment: {
        existingCoverage: testTouchedFiles.length ? testTouchedFiles.map((f) => `- \`${f}\``).join("\n") : "_No test files touched by this diff._",
        missingCoverage: missingCoverageFindings.length
          ? missingCoverageFindings.map((f) => `- ${f.title} (\`${f.file}\`)`).join("\n")
          : "_No high-value missing coverage identified._",
      },
      positives: synthesis.positives || "_None called out._",
      stats,
      verificationCommands,
    };

    const report = formatReport(reportState);

    await saveCheckpoint(stateDir, target.number, {
      headRefOid: pr.headRefOid,
      reviewedAt: new Date().toISOString(),
      verdict,
      risk,
      report,
      stats,
    });
    await appendReviewHistory(stateDir, {
      date: new Date().toISOString().slice(0, 10),
      number: target.number,
      title: pr.title,
      verdict,
      risk,
      verifiedCount: verifiedFindings.length,
    });

    return { report, verdict, risk, fromCache: false, target, pr, checkoutDir: keepClone ? checkoutDir : null };
  } finally {
    if (cleanupDir && !keepClone) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  }
}
