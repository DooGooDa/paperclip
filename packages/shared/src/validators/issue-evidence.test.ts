import { describe, expect, it } from "vitest";
import { classifyEvidence, issueEvidencePayloadSchema } from "./issue.js";

describe("classifyEvidence — RICH (2+ classes)", () => {
  it("detects PR/merge + commit SHA", () => {
    const result = classifyEvidence("Merged PR #123, commit deadbeef1 landed");
    expect(result.classes).toEqual(expect.arrayContaining(["pr_merge", "commit_sha"]));
    expect(result.verdict).toBe("RICH");
  });

  it("detects test result + URL", () => {
    const result = classifyEvidence("42/42 pass — see https://ci.example.com/run/1");
    expect(result.classes).toEqual(expect.arrayContaining(["test_result", "url"]));
    expect(result.verdict).toBe("RICH");
  });

  it("detects file path + Slack ts", () => {
    const result = classifyEvidence("wrote artifacts/report.md, posted ts=1700000000");
    expect(result.classes).toEqual(expect.arrayContaining(["file_path", "slack_ts"]));
    expect(result.verdict).toBe("RICH");
  });

  it("detects commit SHA + file path", () => {
    const result = classifyEvidence("commit abc1234 touches scripts/deploy.sh");
    expect(result.classes).toEqual(expect.arrayContaining(["commit_sha", "file_path"]));
    expect(result.verdict).toBe("RICH");
  });
});

describe("classifyEvidence — THIN (<=1 class)", () => {
  it("single URL is THIN", () => {
    const result = classifyEvidence("https://example.com");
    expect(result.classes).toEqual(["url"]);
    expect(result.verdict).toBe("THIN");
  });

  it("single test-result token is THIN", () => {
    const result = classifyEvidence("ran vitest locally");
    expect(result.classes).toEqual(["test_result"]);
    expect(result.verdict).toBe("THIN");
  });

  it("single PR reference is THIN", () => {
    const result = classifyEvidence("PR #5 opened for review");
    expect(result.classes).toEqual(["pr_merge"]);
    expect(result.verdict).toBe("THIN");
  });

  it("empty text is THIN with no classes", () => {
    const result = classifyEvidence("");
    expect(result.classes).toEqual([]);
    expect(result.verdict).toBe("THIN");
  });
});

describe("classifyEvidence — UUID false-positive guard", () => {
  it("bare UUID does NOT count as a commit SHA", () => {
    const result = classifyEvidence("Issue 550e8400-e29b-41d4-a716-446655440000 was discussed");
    expect(result.classes).not.toContain("commit_sha");
    expect(result.verdict).toBe("THIN");
  });

  it("a real SHA next to a UUID is still detected", () => {
    const result = classifyEvidence(
      "commit deadbeef fixed issue 550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result.classes).toContain("commit_sha");
  });
});

describe("classifyEvidence — negation is out of scope", () => {
  it("classifies by pattern only, ignoring negation words", () => {
    // negation("NOT merged")은 T6.3 게이트의 몫 — classifyEvidence는 클래스 존재만 본다.
    const result = classifyEvidence("PR #7 was NOT merged and tests did not pass");
    expect(result.classes).toContain("pr_merge");
  });
});

describe("issueEvidencePayloadSchema", () => {
  it("accepts a valid classification payload", () => {
    const parsed = issueEvidencePayloadSchema.parse({
      classes: ["pr_merge", "commit_sha"],
      verdict: "RICH",
    });
    expect(parsed.verdict).toBe("RICH");
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      issueEvidencePayloadSchema.parse({ classes: [], verdict: "MAYBE" }),
    ).toThrow();
  });

  it("rejects an unknown evidence class", () => {
    expect(() =>
      issueEvidencePayloadSchema.parse({ classes: ["mystery"], verdict: "THIN" }),
    ).toThrow();
  });
});
