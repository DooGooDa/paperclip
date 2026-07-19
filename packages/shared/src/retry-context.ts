/**
 * Retry context — the "retry memory" payload injected into an executor's
 * re-dispatch wake after a reviewer requests changes (E10 S5).
 *
 * Pure (no DB, no IO): the server assembles an IssueFailureRecord in
 * issue-failure-record.ts, then this module shapes it into the compact, bounded
 * RetryContext that rides on the execution-stage wake payload so the (freshly
 * reset) executor session starts already aware of its prior failure.
 *
 * The shape is deliberately open for extension: T10.3 adds a reflection
 * instruction and T10.6 consumes the same record, so new optional fields are
 * added here rather than reshaping the wake plumbing in issues.ts.
 */
import type { FailureClass } from "./failure-classification.js";

/** Max length of the retained error excerpt — keeps the wake payload bounded. */
export const RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH = 600;

const RETRY_ERROR_TRUNCATION_SUFFIX = "…";

/**
 * Compact retry memory for a re-dispatched executor. Only ever present when the
 * issue has at least one prior execution attempt (attemptCount > 0); a first
 * dispatch carries no retryContext at all.
 */
export interface RetryContext {
  /** Prior execution_changes_requested attempts for this issue (always >= 1 here). */
  attemptCount: number;
  /** Failure class of the most recent failing attempt. */
  failureClass: FailureClass;
  /** Bounded excerpt of the most recent error, or null if none was recorded. */
  lastError: string | null;
  /** Class-specific remediation hint, or null when none applies. */
  guidance: string | null;
  /**
   * Idempotency anchor — the run being retried. Combined with attemptCount it
   * forms a stamp (retryContextStamp) so an at-least-once redelivered wake does
   * not re-inject the same attempt's memory. Null when the run is unknown.
   */
  retryOfRunId: string | null;
}

/** Inputs needed to shape a RetryContext — a subset of IssueFailureRecord. */
export interface RetryContextInput {
  attemptCount: number;
  failureClass: FailureClass;
  lastError: string | null;
  retryOfRunId?: string | null;
}

const GUIDANCE_BY_FAILURE_CLASS: Record<FailureClass, string | null> = {
  verify:
    "Prior attempt failed the done-evidence gate. Re-check every acceptance criterion and attach the verification command output before resubmitting.",
  ci: "Prior attempt failed to build/typecheck. Run the build and typecheck locally and fix all errors before resubmitting.",
  review:
    "A reviewer requested changes. Address each review comment explicitly and note how you resolved it.",
  runtime:
    "Prior attempt crashed at runtime. Reproduce the failure, add the missing guard/handling, and verify the process exits cleanly.",
  tool: "Prior attempt failed on a tool/command invocation. Verify the command, path, and permissions before retrying.",
  unknown: null,
};

/** Class-specific remediation hint. Null-safe: unknown / unrecognised => null. */
export function retryGuidanceForFailureClass(failureClass: FailureClass): string | null {
  return GUIDANCE_BY_FAILURE_CLASS[failureClass] ?? null;
}

/**
 * Truncate an error excerpt to a bounded length so the wake payload stays small.
 * Result length is always <= max. Null / whitespace-only passes through as null.
 */
export function truncateRetryError(
  error: string | null | undefined,
  max: number = RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH,
): string | null {
  if (error == null) return null;
  const trimmed = error.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  // Reserve one code unit for the ellipsis so the result is exactly `max` long.
  return `${trimmed.slice(0, Math.max(0, max - 1))}${RETRY_ERROR_TRUNCATION_SUFFIX}`;
}

/**
 * Shape a RetryContext from a failure record. Returns undefined for a first
 * dispatch (attemptCount <= 0) — the undefined return IS the attemptCount gate
 * the wake plumbing relies on: no prior attempt => no retry memory injected.
 */
export function buildRetryContext(input: RetryContextInput): RetryContext | undefined {
  if (!(input.attemptCount > 0)) return undefined;
  return {
    attemptCount: input.attemptCount,
    failureClass: input.failureClass,
    lastError: truncateRetryError(input.lastError),
    guidance: retryGuidanceForFailureClass(input.failureClass),
    retryOfRunId: input.retryOfRunId ?? null,
  };
}

/**
 * Idempotency stamp for a retry injection. Equal stamps => the same attempt's
 * memory => a redelivered wake must not re-inject it. A genuinely newer attempt
 * (new run or higher attemptCount) => a distinct stamp.
 */
export function retryContextStamp(
  ctx: Pick<RetryContext, "attemptCount" | "retryOfRunId">,
): string {
  return `retry:${ctx.retryOfRunId ?? "none"}:attempt:${ctx.attemptCount}`;
}

/**
 * Whether a retry context should be injected given the stamps already seen for
 * this issue's wakes. Blocks re-injecting the same attempt (at-least-once wake
 * delivery, C1) while allowing a genuinely newer attempt through.
 */
export function shouldInjectRetryContext(
  ctx: Pick<RetryContext, "attemptCount" | "retryOfRunId">,
  seenStamps: Iterable<string>,
): boolean {
  const stamp = retryContextStamp(ctx);
  for (const seen of seenStamps) {
    if (seen === stamp) return false;
  }
  return true;
}
