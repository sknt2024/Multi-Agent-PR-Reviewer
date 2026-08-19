// JSON Schemas enforced on Claude Agent SDK structured output (outputFormat: json_schema).
// These are the wire contracts described in the orchestrator spec, section 8 (agent output)
// and section 10 (verify agent).

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
export const CONFIDENCES = ["HIGH", "MEDIUM", "LOW"];
export const VERDICTS = ["VALID", "INVALID", "UNCERTAIN"];

const findingProperties = {
  id: { type: "string", description: "Short stable id, e.g. SEC-001" },
  title: { type: "string" },
  category: { type: "string" },
  severity: { type: "string", enum: SEVERITIES },
  confidence: { type: "string", enum: CONFIDENCES },
  file: { type: "string", description: "Repo-relative path" },
  start_line: { type: "integer" },
  end_line: { type: "integer" },
  problem: { type: "string" },
  evidence: {
    type: "string",
    description: "Concrete code/data-flow evidence, e.g. quoted lines or a call chain. Must be verifiable against the repo.",
  },
  impact: { type: "string" },
  recommendation: { type: "string" },
};

const findingRequired = [
  "id",
  "title",
  "category",
  "severity",
  "confidence",
  "file",
  "start_line",
  "end_line",
  "problem",
  "evidence",
  "impact",
  "recommendation",
];

export const AGENT_FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: findingProperties,
        required: findingRequired,
      },
    },
  },
  required: ["agent", "findings"],
};

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "id of the candidate finding being judged" },
          verdict: { type: "string", enum: VERDICTS },
          reason: {
            type: "string",
            description: "Why. Must reference GATE1-GATE7 checks explicitly (evidence, relevance, reachability, existing protection, actionability, duplication, severity).",
          },
          duplicate_of: {
            type: ["string", "null"],
            description: "id of another candidate finding this duplicates, if any. null if not a duplicate.",
          },
          severity_override: {
            type: ["string", "null"],
            enum: [...SEVERITIES, null],
            description: "Only set if the verifier disagrees with the maker's severity, else null.",
          },
          confidence_override: { type: ["string", "null"], enum: [...CONFIDENCES, null] },
        },
        required: ["id", "verdict", "reason", "duplicate_of", "severity_override", "confidence_override"],
      },
    },
  },
  required: ["verdicts"],
};

export const DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    languages: { type: "array", items: { type: "string" } },
    frameworks: { type: "array", items: { type: "string" } },
    architecture: { type: "string" },
    package_manager: { type: ["string", "null"] },
    intent: { type: "string", description: "What the PR is trying to accomplish" },
    risk_areas: { type: "array", items: { type: "string" } },
    invariants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          rule: { type: "string" },
          source: { type: ["string", "null"] },
        },
        required: ["id", "rule", "source"],
      },
    },
  },
  required: ["languages", "frameworks", "architecture", "package_manager", "intent", "risk_areas", "invariants"],
};

// Used by the synthesis step: prose ONLY, no tool access, strictly grounded in the verified
// findings/stats it's handed — it cannot introduce new findings, only summarize computed ones.
export const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "2-5 concise sentences on overall quality and risk, grounded only in the provided verified findings and stats." },
    positives: { type: "string", description: "Only meaningful improvements actually introduced by this PR's diff. Empty string if none." },
  },
  required: ["summary", "positives"],
};
