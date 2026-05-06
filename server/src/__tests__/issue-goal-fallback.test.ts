import { describe, expect, it } from "vitest";
import {
  resolveIssueGoalId,
  resolveNextIssueGoalId,
} from "../services/issue-goal-fallback.ts";

describe("issue goal fallback", () => {
  it("assigns the company goal when creating an issue with no project/goal keys", () => {
    expect(
      resolveIssueGoalId({
        projectId: undefined,
        goalId: undefined,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("skips the default goal when client explicitly sends projectId=null and goalId=null", () => {
    // Explicit unattached intent (e.g., daily smoke drill TEST issue paths).
    // The client opted out of any project/goal, so the server must not auto-attach.
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("keeps an explicit goal when creating an issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: "goal-2",
        projectGoalId: "goal-3",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("inherits the project goal when creating a project-linked issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        projectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("does not force a company goal when the project has no goal", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        projectGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("backfills the company goal on update for legacy no-project issues", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        currentProjectGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("switches from the company fallback to the project goal when a project is added later", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        currentProjectGoalId: null,
        projectId: "project-1",
        goalId: null,
        projectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("backfills the project goal for legacy project-linked issues on update", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: null,
        currentProjectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("preserves an explicit goal across project fallback changes", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: "goal-explicit",
        currentProjectGoalId: "goal-2",
        projectId: "project-2",
        projectGoalId: "goal-3",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-explicit");
  });
});
