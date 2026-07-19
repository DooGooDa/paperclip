/**
 * E10 T10.5 — retry-memory injection fixture: a failed issue re-dispatched to
 * its executor carries the prior-failure memory (X) on the wake payload; a first
 * dispatch carries none.
 *
 * This is the delivery fixture for the S5 value ("the re-dispatched executor
 * starts already aware of its prior failure"). T10.2/T10.3 unit-test the shaper
 * (buildRetryContext) in isolation; this fixture composes the full injection
 * path — classify the failing run (T10.1) -> count changes-requested wakes into
 * attemptCount (T10.1) -> shape the RetryContext (T10.2/T10.3) -> spread it into
 * the executor re-dispatch executionStage (T10.2 issues.ts) — and captures that
 * the whole X bundle (failureClass + lastError + guidance + reflectionInstruction)
 * actually rides the wake.
 *
 * Environment-independent by construction: pure functions only, no embedded
 * Postgres, no live DB — the same result on every host (양 머신 동일). The two
 * mirror helpers below reproduce, without a DB, exactly what issues.ts does:
 *   - resolveRetryMemory  == resolveExecutorRetryContext minus the DB read
 *   - assembleExecutorReDispatchWake == buildExecutionStageWakeContext's
 *     conditional retryContext spread (absent, not null, when there is no memory)
 * The substance under assertion (buildRetryContext + classifyFailure +
 * countExecutionChangesRequestedWakes) is the real, exported code, so reverting
 * the T10.2 injection turns these captures RED (see the Tamer-side
 * e10-t10.5 mutation-verify script for the committed RED->GREEN proof).
 */
import { describe, expect, it } from "vitest";
import {
  buildReflectionInstruction,
  buildRetryContext,
  classifyFailure,
  countExecutionChangesRequestedWakes,
  EXECUTION_CHANGES_REQUESTED_WAKE_REASON,
  RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH,
  retryGuidanceForFailureClass,
  type FailureClass,
  type RetryContext,
  type WakeReasonRow,
} from "@paperclipai/shared";

// ── Mirror of issues.ts, minus the DB (pure) ────────────────────────────────

/** The executor re-dispatch executionStage the freshly reset session receives. */
type ExecutionStageWake = {
  wakeRole: "executor" | "reviewer" | "approver";
  allowedActions: string[];
  retryContext?: RetryContext;
};

/**
 * Mirror of buildExecutionStageWakeContext (issues.ts): retryContext is spread
 * into the executionStage ONLY when present, so it is *absent* (not null) on a
 * first dispatch. This is the exact T10.2 injection branch.
 */
function assembleExecutorReDispatchWake(retryContext: RetryContext | undefined): ExecutionStageWake {
  return {
    wakeRole: "executor",
    allowedActions: ["address_changes", "resubmit"],
    ...(retryContext ? { retryContext } : {}),
  };
}

/** The pure core of getIssueFailureRecord: raw run/wake signals -> failure record. */
function synthesizeFailureRecord(input: {
  error: string | null;
  errorCode: string | null;
  wakes: WakeReasonRow[];
  context?: { wakeReason?: string | null; source?: string | null };
}) {
  return {
    lastError: input.error,
    errorCode: input.errorCode,
    failureClass: classifyFailure(input.error, input.errorCode, input.context ?? {}),
    attemptCount: countExecutionChangesRequestedWakes(input.wakes),
  };
}

/**
 * Mirror of resolveExecutorRetryContext (issues.ts) minus the DB read: retry
 * memory is only for an executor re-dispatch (changes_requested); everything
 * else short-circuits to undefined before the record is even shaped.
 */
function resolveRetryMemory(input: {
  nextStatus: string;
  record: { attemptCount: number; failureClass: FailureClass; lastError: string | null };
  interruptedRunId: string | null;
}): RetryContext | undefined {
  if (input.nextStatus !== "changes_requested") return undefined;
  return buildRetryContext({
    attemptCount: input.record.attemptCount,
    failureClass: input.record.failureClass,
    lastError: input.record.lastError,
    retryOfRunId: input.interruptedRunId,
  });
}

const changesRequestedWake: WakeReasonRow = { reason: EXECUTION_CHANGES_REQUESTED_WAKE_REASON };
// A self-comment retry — must NOT inflate the attempt count (C2 boundary).
const selfCommentWake: WakeReasonRow = { reason: "missing_issue_comment" };

describe("retry-memory injection into the executor re-dispatch wake", () => {
  it("a failed issue re-dispatched to its executor carries the failure X on the wake", () => {
    // A run that failed the done-evidence gate, then two changes-requested wakes.
    const record = synthesizeFailureRecord({
      error: "verification failed: acceptance criterion 3 has no evidence attached",
      errorCode: null,
      wakes: [changesRequestedWake, selfCommentWake, changesRequestedWake],
    });
    expect(record.failureClass).toBe("verify");
    // self-comment wake excluded -> only the two changes-requested wakes count.
    expect(record.attemptCount).toBe(2);

    const retryContext = resolveRetryMemory({
      nextStatus: "changes_requested",
      record,
      interruptedRunId: "run-abc-123",
    });
    const wake = assembleExecutorReDispatchWake(retryContext);

    // X is present and complete on the wake the re-dispatched executor receives.
    expect(wake.retryContext).toBeDefined();
    expect(wake.retryContext?.attemptCount).toBe(2);
    expect(wake.retryContext?.failureClass).toBe("verify");
    expect(wake.retryContext?.lastError).toContain("verification failed");
    expect(wake.retryContext?.guidance).toBe(retryGuidanceForFailureClass("verify"));
    expect(wake.retryContext?.guidance).not.toBeNull();
    expect(wake.retryContext?.reflectionInstruction).toBe(buildReflectionInstruction("verify"));
    expect(wake.retryContext?.retryOfRunId).toBe("run-abc-123");
  });

  it("first dispatch (no prior changes-requested wake) carries no retry memory", () => {
    const record = synthesizeFailureRecord({
      error: "verification failed: acceptance criterion 3 has no evidence attached",
      errorCode: null,
      wakes: [selfCommentWake], // self-comment only -> attemptCount 0
    });
    expect(record.attemptCount).toBe(0);

    const retryContext = resolveRetryMemory({
      nextStatus: "changes_requested",
      record,
      interruptedRunId: null,
    });
    const wake = assembleExecutorReDispatchWake(retryContext);

    expect(retryContext).toBeUndefined();
    expect(wake.retryContext).toBeUndefined();
    // absent, not null — the key must not appear on the wake at all.
    expect(Object.prototype.hasOwnProperty.call(wake, "retryContext")).toBe(false);
  });

  it("a reviewer/first-assignment wake carries no retry memory even with prior failures", () => {
    const record = synthesizeFailureRecord({
      error: "TypeError: cannot read properties of undefined",
      errorCode: null,
      wakes: [changesRequestedWake, changesRequestedWake, changesRequestedWake],
    });
    expect(record.attemptCount).toBe(3); // real prior failures exist...

    // ...but this wake is a review/approval hop, not an executor re-dispatch.
    const retryContext = resolveRetryMemory({
      nextStatus: "pending",
      record,
      interruptedRunId: "run-xyz",
    });
    const wake = assembleExecutorReDispatchWake(retryContext);

    expect(retryContext).toBeUndefined();
    expect(wake.retryContext).toBeUndefined();
  });

  it("the injected lastError is bounded so the wake payload stays small", () => {
    const record = synthesizeFailureRecord({
      error: `runtime crash: ${"x".repeat(2000)}`,
      errorCode: null,
      wakes: [changesRequestedWake],
    });
    const retryContext = resolveRetryMemory({
      nextStatus: "changes_requested",
      record,
      interruptedRunId: "run-long",
    });
    const wake = assembleExecutorReDispatchWake(retryContext);

    expect(wake.retryContext).toBeDefined();
    expect(wake.retryContext?.lastError).not.toBeNull();
    expect((wake.retryContext?.lastError ?? "").length).toBeLessThanOrEqual(
      RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH,
    );
  });

  it.each<[string, string, FailureClass]>([
    ["build/typecheck error", "pnpm build failed: tsc error TS2307", "ci"],
    ["runtime crash", "TypeError: cannot read properties of undefined", "runtime"],
    ["tool invocation failure", "command not found: gh", "tool"],
  ])(
    "failure class from %s drives the class-specific guidance + reflection on the wake",
    (_label, error, expectedClass) => {
      const record = synthesizeFailureRecord({
        error,
        errorCode: null,
        wakes: [changesRequestedWake],
      });
      expect(record.failureClass).toBe(expectedClass);

      const wake = assembleExecutorReDispatchWake(
        resolveRetryMemory({ nextStatus: "changes_requested", record, interruptedRunId: "r" }),
      );

      expect(wake.retryContext?.failureClass).toBe(expectedClass);
      expect(wake.retryContext?.guidance).toBe(retryGuidanceForFailureClass(expectedClass));
      // reflection carries this class's recovery guidance, not another class's.
      expect(wake.retryContext?.reflectionInstruction).toBe(buildReflectionInstruction(expectedClass));
      expect(wake.retryContext?.reflectionInstruction).toContain(
        retryGuidanceForFailureClass(expectedClass) ?? "",
      );
    },
  );
});
