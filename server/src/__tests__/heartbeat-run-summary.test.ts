import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(
      buildHeartbeatRunIssueComment({ result: "done: posted PR #128, see https://example.com/pr/128" }),
    ).toBe("done: posted PR #128, see https://example.com/pr/128");
    expect(
      buildHeartbeatRunIssueComment({ message: "completed sync of 12 issues, 0 errors" }),
    ).toBe("completed sync of 12 issues, 0 errors");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("drops single-token noise such as 'N', 'Y', 'OK', '.', 'done'", () => {
    // Background: agents sometimes terminate a wake with a single-character
    // assistant message ('N', 'Y', '...'). The adapter forwards that as
    // resultJson.summary, and prior to the guard the server posted it as an
    // issue comment. That produced dozens of useless 'N' comments per day.
    expect(buildHeartbeatRunIssueComment({ summary: "N" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "Y" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "OK" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "..." })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "done" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "pass" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "silent" })).toBeNull();
    expect(buildHeartbeatRunIssueComment({ summary: "  N  " })).toBeNull();
  });

  it("keeps short summaries that carry information (digits, urls, ids, colon)", () => {
    // A summary that is short but informational should still be posted.
    expect(buildHeartbeatRunIssueComment({ summary: "PR #128" })).toBe("PR #128");
    expect(buildHeartbeatRunIssueComment({ summary: "DGG-1234" })).toBe("DGG-1234");
    expect(buildHeartbeatRunIssueComment({ summary: "status: done" })).toBe("status: done");
  });

  it("falls through noise summary to the next informative field", () => {
    // When summary is noise but result/message has real content,
    // we should post the informative fallback.
    expect(
      buildHeartbeatRunIssueComment({ summary: "N", result: "posted comment on DGG-1234" }),
    ).toBe("posted comment on DGG-1234");
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});
