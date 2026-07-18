export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Single-token noise guard for auto-issue-comments derived from run summary.
// Background (DGG noise bug, 2026-05-30): when an agent ends a routine_execution
// wake with a single character such as `N`, `Y`, `OK`, `.`, the adapter forwards
// that as `resultJson.summary`, and the server posts it as an issue comment.
// That produces dozens of meaningless `N` comments per day per agent. We never
// want to auto-post such terminal noise; the agent can still write a useful
// comment explicitly via PATCH/POST.
const SINGLE_TOKEN_NOISE_COMMENT_MIN_CHARS = 10;
const SINGLE_TOKEN_NOISE_COMMENT_BLOCKLIST: readonly string[] = [
  "n",
  "y",
  "ok",
  "k",
  "yes",
  "no",
  "...",
  "..",
  ".",
  "-",
  "--",
  "done",
  "pass",
  "fail",
  "true",
  "false",
  "silent",
  "noop",
  "none",
  "null",
];

function isSingleTokenNoiseComment(text: string): boolean {
  const collapsed = text.trim();
  if (collapsed.length === 0) return true;
  if (collapsed.length >= SINGLE_TOKEN_NOISE_COMMENT_MIN_CHARS) return false;
  // Reject anything that is a single word/token with no whitespace and is
  // either in the noise blocklist or has no informational structure
  // (no colon, no digit, no slash, no hyphenated id).
  if (/\s/.test(collapsed)) return false;
  const lowered = collapsed.toLowerCase();
  if (SINGLE_TOKEN_NOISE_COMMENT_BLOCKLIST.includes(lowered)) return true;
  // Bare single-token with no informational punctuation/structure → noise.
  return !/[:\/=]|\d/.test(collapsed);
}

export function readIssueCommentCandidate(value: unknown): string | null {
  const text = readCommentText(value);
  if (text === null) return null;
  if (isSingleTokenNoiseComment(text)) return null;
  return text;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readIssueCommentCandidate(resultJson.summary)
    ?? readIssueCommentCandidate(resultJson.result)
    ?? readIssueCommentCandidate(resultJson.message)
    ?? null
  );
}
