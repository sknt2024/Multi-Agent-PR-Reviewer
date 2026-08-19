import { query } from "@anthropic-ai/claude-agent-sdk";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/**
 * Runs a single fresh Claude Agent SDK session to completion and returns its
 * structured_output (validated against `schema` by the SDK's json_schema
 * output format), plus lightweight run metadata for the audit trail.
 *
 * Every call is a brand-new session (no `resume`/`continue`) so that maker
 * agents don't see each other's output and the VERIFY agent gets fresh
 * context, per the maker/checker separation requirement.
 */
export async function runAgent({
  label,
  systemPrompt,
  prompt,
  schema,
  cwd,
  model,
  maxTurns = 20,
  tools = READ_ONLY_TOOLS,
}) {
  const startedAt = Date.now();
  let lastResult = null;

  const q = query({
    prompt,
    options: {
      cwd,
      model,
      maxTurns,
      tools,
      systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema },
    },
  });

  try {
    for await (const message of q) {
      if (message.type === "result") {
        lastResult = message;
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    return { label, ok: false, error: err.message || String(err), durationMs, output: null };
  }

  const durationMs = Date.now() - startedAt;

  if (!lastResult) {
    return { label, ok: false, error: "No result message received from agent", durationMs, output: null };
  }

  if (lastResult.subtype !== "success" || lastResult.is_error) {
    const reason = lastResult.subtype === "success" ? "is_error" : lastResult.subtype;
    return { label, ok: false, error: `Agent run failed (${reason})`, durationMs, output: null };
  }

  if (lastResult.structured_output === undefined) {
    return { label, ok: false, error: "Agent did not return structured_output", durationMs, output: null };
  }

  return {
    label,
    ok: true,
    error: null,
    durationMs,
    costUsd: lastResult.total_cost_usd,
    numTurns: lastResult.num_turns,
    output: lastResult.structured_output,
  };
}
