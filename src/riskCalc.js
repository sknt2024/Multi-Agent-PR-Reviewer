// Spec section 13 — the final verdict is computed from verified finding severities, not narrated
// by an agent.

export function computeVerdict(verifiedFindings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of verifiedFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  if (counts.CRITICAL > 0) {
    return { risk: "CRITICAL", verdict: "REQUEST CHANGES", counts };
  }
  if (counts.HIGH > 0) {
    return { risk: "HIGH", verdict: "REQUEST CHANGES", counts };
  }
  if (counts.MEDIUM >= 3) {
    // "unless multiple medium issues create significant combined risk" (spec section 13)
    return { risk: "HIGH", verdict: "REQUEST CHANGES", counts };
  }
  if (counts.MEDIUM > 0) {
    return { risk: "MEDIUM", verdict: "APPROVE WITH COMMENTS", counts };
  }
  if (counts.LOW > 0 || counts.INFO > 0) {
    return { risk: "LOW", verdict: "APPROVE WITH COMMENTS", counts };
  }
  return { risk: "LOW", verdict: "APPROVE", counts };
}
