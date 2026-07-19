import { describe, expect, it } from "vitest";
import type { FailureClass } from "./failure-classification.js";
import {
  REFLECTION_COMPLIANCE_MARKERS,
  REFLECTION_INSTRUCTION_PREFIX,
  RETRY_CONTEXT_LAST_ERROR_MAX_LENGTH,
  buildReflectionInstruction,
  buildRetryContext,
  classifyRetryDisposition,
  firstCommentSignalsReflection,
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

describe("buildReflectionInstruction — prefix + class-specific recovery guidance", () => {
  it("always starts with the Reflection-Before-Retry prefix (the 'do differently' directive)", () => {
    for (const cls of ["verify", "ci", "review", "runtime", "tool", "unknown"] as FailureClass[]) {
      expect(buildReflectionInstruction(cls).startsWith(REFLECTION_INSTRUCTION_PREFIX)).toBe(true);
    }
  });

  it("combines the class-specific guidance so verify => verify guidance, review => review guidance", () => {
    const verify = buildReflectionInstruction("verify");
    const review = buildReflectionInstruction("review");
    // Each class's instruction embeds that class's own recovery guidance (deterministic per class).
    expect(verify).toContain(retryGuidanceForFailureClass("verify")!);
    expect(review).toContain(retryGuidanceForFailureClass("review")!);
    // ...and not the other class's guidance (the mapping is class-specific, not shared).
    expect(verify).not.toContain(retryGuidanceForFailureClass("review")!);
    expect(review).not.toContain(retryGuidanceForFailureClass("verify")!);
  });

  it("ci / runtime / tool each embed their own class guidance", () => {
    for (const cls of ["ci", "runtime", "tool"] as FailureClass[]) {
      expect(buildReflectionInstruction(cls)).toContain(retryGuidanceForFailureClass(cls)!);
    }
  });

  it("unknown class (no specific guidance) => the prefix stands alone (still non-empty)", () => {
    expect(buildReflectionInstruction("unknown")).toBe(REFLECTION_INSTRUCTION_PREFIX);
    expect(buildReflectionInstruction("unknown").length).toBeGreaterThan(0);
  });
});

describe("buildRetryContext — reflection instruction rides the same wake context", () => {
  it("attemptCount > 0 => reflectionInstruction is present and class-specific", () => {
    const ctx = buildRetryContext({
      attemptCount: 2,
      failureClass: "verify",
      lastError: "verification failed: evidence missing for AC 2",
      retryOfRunId: "run-abc",
    });
    expect(ctx?.reflectionInstruction).toBeTruthy();
    expect(ctx?.reflectionInstruction).toBe(buildReflectionInstruction("verify"));
  });

  it("failure summary (what failed) + reflection instruction (what's different) share one payload", () => {
    // AC: T10.2 injection summary and the T10.3 reflection directive arrive in the
    // same wake context — proven by both living on the single returned RetryContext.
    const ctx = buildRetryContext({
      attemptCount: 1,
      failureClass: "review",
      lastError: "reviewer requested changes: rename the field",
      retryOfRunId: "run-r",
    });
    expect(ctx).toBeDefined();
    expect(ctx?.lastError).toContain("reviewer requested changes"); // what failed (T10.2)
    expect(ctx?.guidance).toBeTruthy(); // remediation hint (T10.2)
    expect(ctx?.reflectionInstruction).toContain(REFLECTION_INSTRUCTION_PREFIX); // what's different (T10.3)
  });

  it("first dispatch (attemptCount = 0) => no RetryContext, so no reflection instruction injected", () => {
    const ctx = buildRetryContext({
      attemptCount: 0,
      failureClass: "verify",
      lastError: "should never appear on a first dispatch",
    });
    expect(ctx).toBeUndefined();
    expect(ctx?.reflectionInstruction).toBeUndefined();
  });
});

describe("firstCommentSignalsReflection — T10.4 compliance query stub (observation axis)", () => {
  it("detects a first comment that states a change of approach", () => {
    expect(
      firstCommentSignalsReflection("This time I will run the tests differently and quote the output."),
    ).toBe(true);
    expect(firstCommentSignalsReflection("이전과 다르게 타입 가드를 먼저 추가한다")).toBe(true);
    expect(firstCommentSignalsReflection("Instead of re-running the same build, I fix the import.")).toBe(true);
  });

  it("returns false for a comment that just repeats the work with no reflection", () => {
    expect(firstCommentSignalsReflection("Working on the issue now.")).toBe(false);
  });

  it("null / empty => not compliant", () => {
    expect(firstCommentSignalsReflection(null)).toBe(false);
    expect(firstCommentSignalsReflection(undefined)).toBe(false);
    expect(firstCommentSignalsReflection("")).toBe(false);
  });

  it("markers are declared as named constants (no inline magic strings)", () => {
    expect(REFLECTION_COMPLIANCE_MARKERS.length).toBeGreaterThan(0);
    expect(REFLECTION_COMPLIANCE_MARKERS).toContain("differently");
  });
});

describe("classifyRetryDisposition — retry axis exhaustion gate (E10 T10.6)", () => {
  it("attemptCount = 0 => no prior attempt (first dispatch injects nothing)", () => {
    expect(classifyRetryDisposition(0, 3)).toBe("no_prior_attempt");
  });

  it("attemptCount below the limit => retry (re-dispatch with memory)", () => {
    expect(classifyRetryDisposition(1, 3)).toBe("retry");
    expect(classifyRetryDisposition(2, 3)).toBe("retry");
  });

  it("attemptCount at the limit => exhausted (escalate instead of re-dispatch)", () => {
    expect(classifyRetryDisposition(3, 3)).toBe("exhausted");
  });

  it("attemptCount over the limit => exhausted", () => {
    expect(classifyRetryDisposition(4, 3)).toBe("exhausted");
    expect(classifyRetryDisposition(10, 3)).toBe("exhausted");
  });

  it("boundary is inclusive at maxAttempts and honors a custom limit", () => {
    expect(classifyRetryDisposition(4, 5)).toBe("retry");
    expect(classifyRetryDisposition(5, 5)).toBe("exhausted");
  });
});
