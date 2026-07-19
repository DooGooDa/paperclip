import { describe, expect, it } from "vitest";
import type { FailureClass } from "./failure-classification.js";
import {
  RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH,
  buildRetryContext,
  retryContextStamp,
  retryGuidanceForFailureClass,
  shouldInjectRetryContext,
  truncateRetryError,
} from "./retry-context.js";

describe("buildRetryContext — attemptCount gate (populate only when > 0)", () => {
  it("attemptCount = 2 => retryContext is present and populated", () => {
    const ctx = buildRetryContext({
      attemptCount: 2,
      failureClass: "verify",
      lastError: "verification failed: evidence missing for AC 2",
      retryOfRunId: "run-abc",
    });
    expect(ctx).toBeDefined();
    expect(ctx).toMatchObject({
      attemptCount: 2,
      failureClass: "verify",
      retryOfRunId: "run-abc",
    });
    expect(ctx?.guidance).toBeTruthy();
    expect(ctx?.lastError).toContain("verification failed");
  });

  it("attemptCount = 0 (first dispatch) => retryContext is absent (undefined)", () => {
    const ctx = buildRetryContext({
      attemptCount: 0,
      failureClass: "verify",
      lastError: "should never appear on a first dispatch",
    });
    expect(ctx).toBeUndefined();
  });

  it("negative attemptCount is also treated as no prior attempt => undefined", () => {
    expect(
      buildRetryContext({ attemptCount: -1, failureClass: "ci", lastError: "x" }),
    ).toBeUndefined();
  });

  it("retryOfRunId defaults to null when the interrupted run is unknown", () => {
    const ctx = buildRetryContext({ attemptCount: 1, failureClass: "runtime", lastError: null });
    expect(ctx?.retryOfRunId).toBeNull();
  });
});

describe("truncateRetryError — bounded excerpt, null-safe", () => {
  it("caps a long error at RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH with an ellipsis", () => {
    const longError = "e".repeat(RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH + 500);
    const out = truncateRetryError(longError);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("leaves a short error untouched (trimmed)", () => {
    expect(truncateRetryError("  short error  ")).toBe("short error");
  });

  it("null / undefined / whitespace-only => null", () => {
    expect(truncateRetryError(null)).toBeNull();
    expect(truncateRetryError(undefined)).toBeNull();
    expect(truncateRetryError("   ")).toBeNull();
  });

  it("buildRetryContext truncates lastError through the same bound", () => {
    const longError = "x".repeat(RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH + 100);
    const ctx = buildRetryContext({ attemptCount: 1, failureClass: "ci", lastError: longError });
    expect(ctx?.lastError!.length).toBeLessThanOrEqual(RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH);
  });
});

describe("retryGuidanceForFailureClass — null-safe per class", () => {
  const classesWithGuidance: FailureClass[] = ["verify", "ci", "review", "runtime", "tool"];
  for (const cls of classesWithGuidance) {
    it(`${cls} => a non-empty guidance string`, () => {
      const guidance = retryGuidanceForFailureClass(cls);
      expect(typeof guidance).toBe("string");
      expect((guidance ?? "").length).toBeGreaterThan(0);
    });
  }

  it("unknown => null (null-safe, no fabricated guidance)", () => {
    expect(retryGuidanceForFailureClass("unknown")).toBeNull();
  });
});

describe("retry idempotency — stamp blocks re-injecting the same attempt", () => {
  it("identical retryOfRunId + attemptCount => identical stamp", () => {
    const a = retryContextStamp({ attemptCount: 3, retryOfRunId: "run-xyz" });
    const b = retryContextStamp({ attemptCount: 3, retryOfRunId: "run-xyz" });
    expect(a).toBe(b);
  });

  it("a different attemptCount or run => a different stamp", () => {
    const base = retryContextStamp({ attemptCount: 3, retryOfRunId: "run-xyz" });
    expect(retryContextStamp({ attemptCount: 4, retryOfRunId: "run-xyz" })).not.toBe(base);
    expect(retryContextStamp({ attemptCount: 3, retryOfRunId: "run-other" })).not.toBe(base);
  });

  it("shouldInjectRetryContext blocks a stamp already seen, allows a new attempt", () => {
    const ctx = { attemptCount: 2, retryOfRunId: "run-1" };
    const seen = [retryContextStamp(ctx)];
    // Same attempt already injected -> block (at-least-once redelivery).
    expect(shouldInjectRetryContext(ctx, seen)).toBe(false);
    // A newer attempt (higher count) is not in the seen set -> allow.
    expect(shouldInjectRetryContext({ attemptCount: 3, retryOfRunId: "run-1" }, seen)).toBe(true);
  });

  it("null retryOfRunId still yields a stable, distinguishable stamp", () => {
    const s = retryContextStamp({ attemptCount: 1, retryOfRunId: null });
    expect(s).toBe(retryContextStamp({ attemptCount: 1, retryOfRunId: null }));
    expect(s).not.toBe(retryContextStamp({ attemptCount: 2, retryOfRunId: null }));
  });
});
