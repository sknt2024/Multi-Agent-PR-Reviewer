// Mechanical (computed, not narrated) pre-filtering — spec section 9. These are the gates that
// can be decided from data alone; the semantic gates (reachability, existing protection,
// actionability, severity justification) are left to the fresh-context VERIFY agent, which is
// explicitly instructed to apply GATE1-GATE7 per finding.

function normalizeTitle(title) {
  return (title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titlesOverlap(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(" ").filter((w) => w.length > 3));
  const wb = new Set(nb.split(" ").filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

function linesOverlap(f1, f2) {
  if (f1.file !== f2.file) return false;
  const [s1, e1] = [f1.start_line, f1.end_line].sort((a, b) => a - b);
  const [s2, e2] = [f2.start_line, f2.end_line].sort((a, b) => a - b);
  return s1 <= e2 + 3 && s2 <= e1 + 3; // small slack for near-adjacent lines
}

/**
 * GATE1 (evidence) + GATE6 (duplication), computed mechanically before spending VERIFY tokens.
 * Every maker finding gets a globally unique id (agentKey:localId) to avoid collisions.
 */
export function applyMechanicalGates(agentResults) {
  const candidates = [];
  const rejected = [];

  for (const result of agentResults) {
    if (!result.ok || !result.output?.findings) continue;
    for (const finding of result.output.findings) {
      const globalId = `${result.agentKey}:${finding.id}`;
      const enriched = { ...finding, id: globalId, sourceAgent: result.agentKey };

      if (!finding.evidence?.trim() || !finding.problem?.trim()) {
        rejected.push({ finding: enriched, gate: "GATE1_EVIDENCE", reason: "Missing evidence or problem statement" });
        continue;
      }
      if (!finding.file?.trim()) {
        rejected.push({ finding: enriched, gate: "GATE1_EVIDENCE", reason: "No file specified" });
        continue;
      }
      candidates.push(enriched);
    }
  }

  // GATE6: mechanical duplicate merge across agents (same file, overlapping lines, similar title).
  // Keep the earliest-seen as canonical; record the rest as merged so the VERIFY agent sees one.
  const merged = [];
  const mergedAway = [];
  for (const c of candidates) {
    const dupOf = merged.find((m) => linesOverlap(m, c) && titlesOverlap(m.title, c.title));
    if (dupOf) {
      dupOf.mergedFrom = [...(dupOf.mergedFrom || []), c.id];
      mergedAway.push({ finding: c, gate: "GATE6_DUPLICATION", reason: `Mechanically merged into ${dupOf.id}` });
    } else {
      merged.push(c);
    }
  }

  return { candidates: merged, rejected: [...rejected, ...mergedAway] };
}
