/**
 * Failure classification — maps a failed run's error signal to a stable
 * FailureClass, and counts execution-retry ("changes requested") wakes.
 *
 * This module is pure (no DB, no IO) so it can be unit-tested with fixtures and
 * shared between the server (which assembles the inputs from the database in
 * issue-failure-record.ts) and any downstream retry-memory logic.
 *
 * The keyword-matching approach is ported from the grind error-classifier,
 * adapted to Paperclip's six failure classes. `review` is Paperclip-specific:
 * it is derived from wake/review context (an execution_changes_requested wake
 * or a comment/review rejection), not from a free-text error string alone.
 */

export type FailureClass = "verify" | "ci" | "review" | "runtime" | "tool" | "unknown";

/**
 * Wake reason emitted when an issue is re-dispatched to its executor because a
 * reviewer requested changes. This is the ONLY wake reason that counts toward
 * the execution attempt count — deliberately distinct from:
 *   - "missing_issue_comment"    (C2 self-comment retry)
 *   - "transient_failure_retry"  (bounded transient retry / scheduledRetryAttempt)
 *   - monitor / watchdog wakes   (monitorAttemptCount)
 * so that self-comment and monitor events never inflate the attempt count.
 */
export const EXECUTION_CHANGES_REQUESTED_WAKE_REASON = "execution_changes_requested";

/** Context signals — assembled from heartbeat_runs.context_snapshot by the server. */
export interface FailureClassificationContext {
  /** context_snapshot.wakeReason — an execution_changes_requested wake means a review sent this back. */
  wakeReason?: string | null;
  /** context_snapshot.source — e.g. "issue.comment_rejected" / a review-request origin. */
  source?: string | null;
}

/** A wakeup row reduced to the only field the counter reads. */
export interface WakeReasonRow {
  reason?: string | null;
}

// ── Keyword tables (lowercase; first hit wins in table order) ────────────────

const REVIEW_KEYWORDS = [
  "changes requested",
  "review rejected",
  "comment rejected",
  "rejected by reviewer",
  "reviewer requested",
  "review_request",
  "comment_rejected",
];

const CI_KEYWORDS = [
  "compilation",
  "compile error",
  "build failed",
  "build error",
  "typecheck",
  "tsc ",
  "eslint",
  "lint error",
  "syntax error",
  "cannot find module",
  "module not found",
  "is not assignable",
  "unexpected token",
  "ci failed",
  "pnpm build",
];

const VERIFY_KEYWORDS = [
  "verification failed",
  "evidence",
  "done gate",
  "done-gate",
  "gate rejected",
  "assertion",
  "assert",
  "expected",
  "test failed",
  "tests failed",
  "did not pass",
  "acceptance criteria",
  "ac not met",
];

const RUNTIME_KEYWORDS = [
  "exit code",
  "segfault",
  "sigsegv",
  "sigkill",
  "out of memory",
  "oom",
  "killed",
  "process exited",
  "signal",
  "panic",
  "unhandled exception",
  "unhandled rejection",
  "cannot read properties",
  "econnrefused",
  "etimedout",
  "timeout",
  "timed out",
  "crashed",
  "core dumped",
];

const TOOL_KEYWORDS = [
  "command not found",
  "permission denied",
  "no such file",
  "enoent",
  "spawn",
  "mcp",
  "tool error",
  "tool call failed",
  "unknown tool",
  "invalid tool",
];

const KEYWORD_TABLE: ReadonlyArray<readonly [Exclude<FailureClass, "unknown">, readonly string[]]> = [
  ["review", REVIEW_KEYWORDS],
  ["ci", CI_KEYWORDS],
  ["verify", VERIFY_KEYWORDS],
  ["runtime", RUNTIME_KEYWORDS],
  ["tool", TOOL_KEYWORDS],
];

const REVIEW_SOURCE_RE = /comment_rejected|review_request|reviewrequest|execution_review|changes_requested|review_rejected/;
const REVIEW_ERROR_CODE_RE = /review|changes_requested|comment_rejected/;

/**
 * Review is derived from context/structured signals, never from the C2
 * self-comment status (issue_comment_status) — conflating the two would let
 * "missing_issue_comment" (C2) masquerade as a review rejection.
 */
function isReviewContext(
  errorCode: string | null | undefined,
  context: FailureClassificationContext,
): boolean {
  if (context.wakeReason === EXECUTION_CHANGES_REQUESTED_WAKE_REASON) return true;
  const source = (context.source ?? "").toLowerCase();
  if (source.length > 0 && REVIEW_SOURCE_RE.test(source)) return true;
  const code = (errorCode ?? "").toLowerCase();
  if (code.length > 0 && REVIEW_ERROR_CODE_RE.test(code)) return true;
  return false;
}

/**
 * Classify a failed run into a FailureClass. Deterministic: review context wins
 * first, then keyword matching over the combined error + errorCode text in
 * table order, then an unknown fallback.
 */
export function classifyFailure(
  error: string | null | undefined,
  errorCode: string | null | undefined,
  context: FailureClassificationContext = {},
): FailureClass {
  if (isReviewContext(errorCode, context)) return "review";

  const haystack = `${error ?? ""} ${errorCode ?? ""}`.toLowerCase().trim();
  if (haystack.length === 0) return "unknown";

  for (const [cls, keywords] of KEYWORD_TABLE) {
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return cls;
    }
  }
  return "unknown";
}

/** Whether a single wake reason counts toward the execution attempt count. */
export function wakeReasonCountsAsExecutionAttempt(reason: string | null | undefined): boolean {
  return reason === EXECUTION_CHANGES_REQUESTED_WAKE_REASON;
}

/**
 * Count execution-retry ("changes requested") wakes. This is the single source
 * of truth the DB accessor uses for attemptCount, so the exclusion of C2
 * self-comment and monitor wakes is exactly what the fixtures prove.
 */
export function countExecutionChangesRequestedWakes(wakes: readonly WakeReasonRow[]): number {
  let count = 0;
  for (const wake of wakes) {
    if (wakeReasonCountsAsExecutionAttempt(wake.reason)) count += 1;
  }
  return count;
}
