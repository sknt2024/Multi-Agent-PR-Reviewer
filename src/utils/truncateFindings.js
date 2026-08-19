// Keeps at most `max` findings, most severe first (findings are assumed pre-sorted).
export function truncateFindings(findings, max) {
  return findings.slice(0, max - 1);
}
