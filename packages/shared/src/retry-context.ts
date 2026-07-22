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
  /**
   * Reflection-Before-Retry directive (T10.3) — asks the re-dispatched executor
   * to state, in its first comment, what it will do differently from the prior
   * approach, combined with the class-specific recovery guidance. Present
   * whenever this RetryContext is (attemptCount > 0); absent on a first dispatch
   * (no RetryContext at all). Instruction text only, NOT an enforced gate —
   * enforcing "state what's different" as a done-gate is E6's territory.
   */
  reflectionInstruction?: string;
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
 * Reflection-Before-Retry directive prefix — ported from the grind loop's
 * reflect()/error-classifier RECOVERY_GUIDES convention. The re-dispatched
 * executor reads this on a retry wake and is asked to state, in its first
 * comment, what it will do differently from the failed approach. This is
 * instruction text only — NOT an enforced gate. Enforcing compliance as a
 * done-gate is E6's territory; E10 wires the instruction and defines the
 * observation axis (T10.4 measures compliance).
 *
 * Named const (no inline magic string) so the injected literal is greppable and
 * the T10.4 compliance query can reference the exact injected text.
 */
export const REFLECTION_INSTRUCTION_PREFIX =
  "This is a retry: a prior attempt on this issue already failed. Before touching the work, post a first comment that states explicitly what you will do differently from the previous approach — do not silently repeat the steps that failed.";

/**
 * Compose the reflection instruction for a retry wake: the Reflection-Before-Retry
 * prefix combined with the class-specific recovery guidance. The recovery guidance
 * is the grind RECOVERY_GUIDES analog — GUIDANCE_BY_FAILURE_CLASS (T10.1/T10.2),
 * reused rather than duplicated. Always a non-empty string; when a class carries
 * no specific guidance (unknown) the prefix stands alone.
 */
export function buildReflectionInstruction(failureClass: FailureClass): string {
  const recovery = retryGuidanceForFailureClass(failureClass);
  return recovery
    ? `${REFLECTION_INSTRUCTION_PREFIX} ${recovery}`
    : REFLECTION_INSTRUCTION_PREFIX;
}

/**
 * Observation-axis handoff to T10.4 (E10 scope = instruction wiring + axis
 * definition; the A/B measurement is T10.4). Reflection compliance is measured
 * by whether a retry issue's first executor comment states what is being done
 * differently. These heuristic markers are the seam T10.4's activity_log query
 * keys off — NOT an enforced gate.
 */
export const REFLECTION_COMPLIANCE_MARKERS: readonly string[] = [
  "differently",
  "different approach",
  "instead of",
  "prior approach",
  "previous approach",
  "previous attempt",
  "last attempt",
  "다르게",
  "이전과",
  "이전 접근",
  "대신",
];

/**
 * Pure query stub for T10.4: true when a retry's first comment appears to
 * acknowledge a change of approach (reflection compliance). The T10.4 metrics
 * script applies this per first comment to compute a compliance rate. Heuristic
 * over REFLECTION_COMPLIANCE_MARKERS; null/empty => not compliant.
 */
export function firstCommentSignalsReflection(commentText: string | null | undefined): boolean {
  if (commentText == null) return false;
  const lower = commentText.toLowerCase();
  return REFLECTION_COMPLIANCE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
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
    reflectionInstruction: buildReflectionInstruction(input.failureClass),
  };
}

/**
 * Disposition of an executor re-dispatch decision on the retry axis (E10 T10.6).
 * Given how many execution_changes_requested attempts an issue already had, decide
 * whether a fresh dispatch carries no retry memory ("no_prior_attempt" — first
 * dispatch injects nothing), should be re-dispatched WITH retry memory ("retry"),
 * or has spent its budget and must escalate instead of re-waking ("exhausted").
 */
export type RetryDisposition = "no_prior_attempt" | "retry" | "exhausted";

/**
 * Max execution_changes_requested re-dispatch attempts before the retry axis
 * gives up and escalates to the board (E10 T10.6) instead of re-waking. Lives
 * here (with the retry-axis pure logic) rather than in heartbeat.ts so the route
 * consumer (issues.ts) can import it without pulling the heartbeat service module
 * — a route -> heartbeat import triggers a circular-init that 500s the issue
 * routes. Passed into classifyRetryDisposition as maxAttempts.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Pure retry-axis gate (no DB). The attemptCount>0 lower bound mirrors
 * buildRetryContext (a first dispatch injects nothing); the attemptCount>=maxAttempts
 * upper bound is the T10.6 escalation trigger. The server (issues.ts) resolves
 * attemptCount from the failure record, applies this gate, and either builds the
 * re-dispatch wake or fires the dispatch_retry_exhausted board escalation.
 */
export function classifyRetryDisposition(
  attemptCount: number,
  maxAttempts: number,
): RetryDisposition {
  if (!(attemptCount > 0)) return "no_prior_attempt";
  if (attemptCount >= maxAttempts) return "exhausted";
  return "retry";
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
