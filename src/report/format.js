// Deterministic markdown formatter for spec section 14. No LLM call — everything here is derived
// from computed state so gates stay "computed, not narrated".

function findingBlock(f) {
  return `### [${f.severity}] ${f.title}

**Category:** ${f.category}

**File:** \`${f.file}\`

**Lines:** \`${f.start_line}-${f.end_line}\`

**Confidence:** ${f.confidence}

**Problem**

${f.problem}

**Evidence**

${f.evidence}

**Impact**

${f.impact}

**Recommendation**

${f.recommendation}`;
}

export function formatReport(state) {
  const { pr, verdict, risk, summary, verifiedFindings, testAssessment, positives, stats, verificationCommands } = state;

  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
  const sorted = [...verifiedFindings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const findingsSection = sorted.length
    ? sorted.map(findingBlock).join("\n\n---\n\n")
    : "_No verified findings — nothing material survived independent verification._";

  const verificationLines = (verificationCommands || []).length
    ? verificationCommands.map((c) => `- \`${c.command}\` → ${c.result}`).join("\n")
    : "_No verification commands were run for this PR (no test/lint/build tooling detected, or none applicable to the diff)._";

  return `# PR Review

## Verdict

\`${verdict}\`

## Risk

\`${risk}\`

## Summary

${summary}

---

## Findings

${findingsSection}

---

## Test Assessment

### Existing Coverage

${testAssessment.existingCoverage || "_Not assessed._"}

### Missing Coverage

${testAssessment.missingCoverage || "_None identified._"}

### Verification

${verificationLines}

---

## Positive Changes

${positives || "_None called out._"}

---

## Review Statistics

\`\`\`text
Agents executed: ${stats.agentsExecuted}
Candidate findings: ${stats.candidateFindings}
Verified findings: ${stats.verifiedFindings}
Rejected findings: ${stats.rejectedFindings}
Uncertain findings: ${stats.uncertainFindings}

CRITICAL: ${stats.severityCounts.CRITICAL || 0}
HIGH: ${stats.severityCounts.HIGH || 0}
MEDIUM: ${stats.severityCounts.MEDIUM || 0}
LOW: ${stats.severityCounts.LOW || 0}
INFO: ${stats.severityCounts.INFO || 0}
\`\`\`

---
_Reviewed PR [#${pr.number}](${pr.url}) — ${pr.title}_
`;
}
