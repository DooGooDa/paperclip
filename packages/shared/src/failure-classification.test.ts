import { describe, expect, it } from "vitest";
import {
  EXECUTION_CHANGES_REQUESTED_WAKE_REASON,
  classifyFailure,
  countExecutionChangesRequestedWakes,
  wakeReasonCountsAsExecutionAttempt,
  type FailureClass,
} from "./failure-classification.js";

describe("classifyFailure — six deterministic classes", () => {
  const cases: Array<{ name: string; error: string | null; errorCode?: string | null; expected: FailureClass }> = [
    { name: "ci: typecheck / cannot find module", error: "tsc error: cannot find module '@paperclipai/db'", expected: "ci" },
    { name: "verify: done-gate evidence", error: "verification failed: evidence missing for AC 2", expected: "verify" },
    { name: "runtime: OOM exit code", error: "process exited with exit code 137 (killed, out of memory)", expected: "runtime" },
    { name: "tool: spawn ENOENT", error: "spawn git ENOENT: command not found", expected: "tool" },
    { name: "review: error text rejection", error: "changes requested by reviewer on issue thread", expected: "review" },
    { name: "unknown: opaque message", error: "the flux capacitor destabilized", expected: "unknown" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(classifyFailure(c.error, c.errorCode ?? null)).toBe(c.expected);
    });
  }

  it("unknown fallback for null / empty error with no context", () => {
    expect(classifyFailure(null, null)).toBe("unknown");
    expect(classifyFailure("", "")).toBe("unknown");
    expect(classifyFailure("   ", undefined)).toBe("unknown");
  });

  it("review is derived from an execution_changes_requested wake context", () => {
    expect(
      classifyFailure("resubmit your work", null, { wakeReason: EXECUTION_CHANGES_REQUESTED_WAKE_REASON }),
    ).toBe("review");
  });

  it("review is derived from a comment_rejected source", () => {
    expect(classifyFailure("please address feedback", null, { source: "issue.comment_rejected" })).toBe("review");
  });

  it("review is derived from a review-flavored error code", () => {
    expect(classifyFailure("send back", "review_changes_requested")).toBe("review");
  });

  it("does NOT treat a C2 missing-comment error as review", () => {
    // C2 self-comment failure must never masquerade as a reviewer rejection.
    expect(classifyFailure("missing issue comment; retry required", "missing_issue_comment")).not.toBe("review");
  });
});

describe("countExecutionChangesRequestedWakes — attemptCount separation", () => {
  it("counts only execution_changes_requested wakes", () => {
    const wakes = [
      { reason: EXECUTION_CHANGES_REQUESTED_WAKE_REASON },
      { reason: EXECUTION_CHANGES_REQUESTED_WAKE_REASON },
      { reason: "missing_issue_comment" }, // C2 self-comment retry
      { reason: "transient_failure_retry" }, // bounded transient retry
      { reason: "task_watchdog_monitor" }, // monitor / watchdog wake
      { reason: null },
    ];
    expect(countExecutionChangesRequestedWakes(wakes)).toBe(2);
  });

  it("excludes C2 self-comment and monitor events from the attempt count", () => {
    const c2AndMonitorOnly = [
      { reason: "missing_issue_comment" },
      { reason: "task_watchdog_monitor" },
      { reason: "max_turns_continuation_retry" },
    ];
    expect(countExecutionChangesRequestedWakes(c2AndMonitorOnly)).toBe(0);
  });

  it("returns 0 for an empty wake list", () => {
    expect(countExecutionChangesRequestedWakes([])).toBe(0);
  });

  it("wakeReasonCountsAsExecutionAttempt is true only for the changes-requested reason", () => {
    expect(wakeReasonCountsAsExecutionAttempt(EXECUTION_CHANGES_REQUESTED_WAKE_REASON)).toBe(true);
    expect(wakeReasonCountsAsExecutionAttempt("missing_issue_comment")).toBe(false);
    expect(wakeReasonCountsAsExecutionAttempt(null)).toBe(false);
    expect(wakeReasonCountsAsExecutionAttempt(undefined)).toBe(false);
  });
});
