import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

// Deterministic n-of-m quorum fixture (E8 T8.4): a 2-of-3 review stage proves that
// the vote count — not any live infrastructure — decides stage advancement.
//   1 vote  → no transition (stays pending, rotates the reviewer seat)
//   2 votes → transition (stage completes, the next stage becomes active)
// These pure-function cases are machine-identical on any host: no embedded pg, no network.

// Executor / returnAssignee — routes work into review; excluded from the quorum count.
const executorAgentId = "11111111-1111-4111-8111-111111111111";
// Three distinct reviewer participants for a 2-of-3 quorum stage.
const reviewerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reviewerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const approverUserId = "approver-user";

// 2-of-3 review stage followed by a single-approver approval stage, so a satisfied
// quorum can be observed advancing to the *next* stage (not just completing).
function twoOfThreePolicy(): IssueExecutionPolicy {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        type: "review",
        approvalsNeeded: 2,
        participants: [
          { type: "agent", agentId: reviewerA },
          { type: "agent", agentId: reviewerB },
          { type: "agent", agentId: reviewerC },
        ],
      },
      {
        type: "approval",
        participants: [{ type: "user", userId: approverUserId }],
      },
    ],
  })!;
}

function pendingReviewState(policy: IssueExecutionPolicy, overrides: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: policy.stages[0].id,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerA },
    returnAssignee: { type: "agent", agentId: executorAgentId },
    currentStageApprovers: [],
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

describe("2-of-3 stage quorum fixture (1 vote = no transition, 2 votes = transition)", () => {
  it("starts the 2-of-3 stage pending with zero approvals (no transition before any vote)", () => {
    const policy = twoOfThreePolicy();
    expect(policy.stages[0].approvalsNeeded).toBe(2);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: executorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: executorAgentId },
      commentBody: "Implementation ready for review",
    });

    const state = result.patch.executionState as IssueExecutionState;
    expect(state.status).toBe("pending");
    expect(state.currentStageType).toBe("review");
    expect(state.currentStageId).toBe(policy.stages[0].id);
    // zero approvals recorded — the stage did not auto-complete
    expect(state.currentStageApprovers).toEqual([]);
    expect(state.completedStageIds).toEqual([]);
    // the executor handoff is not an approval — no decision is emitted
    expect(result.decision).toBeUndefined();
  });

  it("keeps the 2-of-3 stage pending after the first approval and rotates to the next participant", () => {
    const policy = twoOfThreePolicy();
    const reviewStageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerA,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pendingReviewState(policy, {
          currentParticipant: { type: "agent", agentId: reviewerA },
        }),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerA },
      commentBody: "First of three reviewers approves",
    });

    const state = result.patch.executionState as IssueExecutionState;
    // 1 of 2 — must NOT complete; same review stage stays pending
    expect(state.status).toBe("pending");
    expect(state.currentStageId).toBe(reviewStageId);
    expect(state.currentStageType).toBe("review");
    expect(state.currentStageApprovers).toMatchObject([{ type: "agent", agentId: reviewerA }]);
    // rotated to a different, not-yet-approved participant (B or C)
    expect(state.currentParticipant).not.toEqual({ type: "agent", agentId: reviewerA });
    expect(result.patch.assigneeAgentId).not.toBe(reviewerA);
    expect([reviewerB, reviewerC]).toContain(result.patch.assigneeAgentId);
    expect(result.decision).toMatchObject({ stageId: reviewStageId, stageType: "review", outcome: "approved" });
  });

  it("completes the 2-of-3 stage on the second distinct approval and advances to the next stage", () => {
    const policy = twoOfThreePolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerB,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pendingReviewState(policy, {
          currentParticipant: { type: "agent", agentId: reviewerB },
          currentStageApprovers: [{ type: "agent", agentId: reviewerA }],
        }),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerB },
      commentBody: "Second distinct reviewer approves",
    });

    const state = result.patch.executionState as IssueExecutionState;
    // 2 of 2 — quorum reached: review stage completes, approval stage becomes active
    expect(state.status).toBe("pending");
    expect(state.currentStageId).toBe(approvalStageId);
    expect(state.currentStageType).toBe("approval");
    expect(state.completedStageIds).toEqual([reviewStageId]);
    expect(state.currentParticipant).toMatchObject({ type: "user", userId: approverUserId });
    // approver list reset for the newly active stage
    expect(state.currentStageApprovers).toEqual([]);
    expect(result.patch.assigneeUserId).toBe(approverUserId);
    expect(result.decision).toMatchObject({ stageId: reviewStageId, stageType: "review", outcome: "approved" });
  });

  it("counts a repeated approval from the same reviewer only once (idempotent, no transition)", () => {
    const policy = twoOfThreePolicy();

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerA,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pendingReviewState(policy, {
          currentParticipant: { type: "agent", agentId: reviewerA },
          currentStageApprovers: [{ type: "agent", agentId: reviewerA }],
        }),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerA },
      commentBody: "Same reviewer approves a second time",
    });

    const state = result.patch.executionState as IssueExecutionState;
    // deduped → still 1 of 2, stage stays pending (no double-count)
    expect(state.status).toBe("pending");
    expect(state.currentStageApprovers).toHaveLength(1);
  });

  it("excludes the executor's own approval from the quorum count", () => {
    // Defensive: even if the executor is a listed participant and holds the active seat,
    // their approval must not advance the quorum (returnAssignee is excluded).
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          approvalsNeeded: 2,
          participants: [
            { type: "agent", agentId: reviewerA },
            { type: "agent", agentId: reviewerB },
            { type: "agent", agentId: executorAgentId },
          ],
        },
      ],
    })!;
    const reviewStageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: executorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: executorAgentId },
          returnAssignee: { type: "agent", agentId: executorAgentId },
          currentStageApprovers: [{ type: "agent", agentId: reviewerA }],
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: executorAgentId },
      commentBody: "Executor attempts to self-approve",
    });

    const state = result.patch.executionState as IssueExecutionState;
    // executor approval not counted → still 1 of 2, stage stays pending
    expect(state.status).toBe("pending");
    expect(state.currentStageApprovers).toMatchObject([{ type: "agent", agentId: reviewerA }]);
    expect(state.currentStageApprovers).toHaveLength(1);
  });

  it("requires the full quorum on a high-risk stage but transitions immediately on a low-risk stage", () => {
    // T8.5 hand-off: the deterministic branch that proves risk-tiered quorum without live
    // infrastructure. Same single approval, opposite outcome purely from approvalsNeeded.
    const lowRiskPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          approvalsNeeded: 1,
          participants: [
            { type: "agent", agentId: reviewerA },
            { type: "agent", agentId: reviewerB },
          ],
        },
      ],
    })!;
    const highRiskPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          approvalsNeeded: 2,
          participants: [
            { type: "agent", agentId: reviewerA },
            { type: "agent", agentId: reviewerB },
          ],
        },
      ],
    })!;
    expect(lowRiskPolicy.stages[0].approvalsNeeded).toBe(1);
    expect(highRiskPolicy.stages[0].approvalsNeeded).toBe(2);

    function firstApproval(policy: IssueExecutionPolicy) {
      return applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: reviewerA,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: reviewerA },
            returnAssignee: { type: "agent", agentId: executorAgentId },
            currentStageApprovers: [],
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerA },
        commentBody: "single approval",
      });
    }

    const lowRisk = firstApproval(lowRiskPolicy).patch.executionState as IssueExecutionState;
    const highRisk = firstApproval(highRiskPolicy).patch.executionState as IssueExecutionState;

    // low-risk (needs 1): the single approval completes the stage immediately
    expect(lowRisk.status).toBe("completed");
    expect(lowRisk.completedStageIds).toEqual([lowRiskPolicy.stages[0].id]);
    // high-risk (needs 2): the identical single approval does NOT transition
    expect(highRisk.status).toBe("pending");
    expect(highRisk.currentStageApprovers).toHaveLength(1);
  });
});
