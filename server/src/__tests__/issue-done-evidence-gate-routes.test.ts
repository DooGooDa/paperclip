import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  orderBy: mockDbSelectOrderBy,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

function makeIssue(status: "todo" | "done" | "blocked" | "cancelled" | "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

function agentActor(agentId = "22222222-2222-4222-8222-222222222222") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    source: "agent_key",
    runId: "run-1",
  };
}

async function waitForWakeup(assertion: () => void) {
  await vi.waitFor(assertion);
}

describe.sequential("issue done evidence gate routes (T6.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockExternalObjectService.syncCommentSafely.mockReset();
    mockExternalObjectService.syncIssueSafely.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
    mockExternalObjectService.syncIssueSafely.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    // E6 done evidence gate (T6.3): default the issue's prior comments to RICH evidence
    // (PR merge + test result) so auto-approval mechanics under test are not blocked by
    // the evidence gate. Cases exercising the gate itself override this per-test.
    mockIssueService.listComments.mockResolvedValue([
      { body: "Evidence: merged PR #123, tests 12/12 pass" },
    ]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = input.action !== "tasks:manage_active_checkouts";
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : "Missing active checkout override.",
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        reportsTo: null,
        permissions: { canCreateAgents: false },
      },
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      if (reference === "ambiguous-codex") {
        return { ambiguous: true, agent: null };
      }
      if (reference === "missing-codex") {
        return { ambiguous: false, agent: null };
      }
      if (reference === "codexcoder") {
        return {
          ambiguous: false,
          agent: { id: "33333333-3333-4333-8333-333333333333" },
        };
      }
      return {
        ambiguous: false,
        agent: { id: reference },
      };
    });
  });

  const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
  const EXECUTOR_AGENT_ID = "22222222-2222-4222-8222-222222222222";
  const REVIEWER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
  const RICH_REVIEW_BODY =
    "## Review: PAP-580 - APPROVED\n\nEvidence: merged PR #123, tests 12/12 pass.";
  const THIN_REVIEW_BODY = "## Review: PAP-580 - APPROVED\n\nLooks good.";

  function doneRejectedCall() {
    return mockLogActivity.mock.calls.find(
      ([, entry]) => (entry as { action?: string })?.action === "issue.done_rejected",
    );
  }

  // ── AC ① — agent done PATCH with THIN evidence is rejected 4xx + audited ──
  it("rejects an agent done PATCH when description + comments are THIN evidence", async () => {
    const issue = { ...makeIssue("in_progress"), description: "Fix the login bug.", originKind: null };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(await installActor(createApp(), agentActor(EXECUTOR_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe("issue_done_evidence_required");
    expect(res.body.details).toMatchObject({ verdict: "THIN", requiredVerdict: "RICH" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(doneRejectedCall()).toBeTruthy();
    expect(doneRejectedCall()?.[1]).toMatchObject({
      action: "issue.done_rejected",
      entityId: ISSUE_ID,
      details: expect.objectContaining({ source: "PATCH /issues/:id (status=done)" }),
    });
  });

  // ── AC ② — same request with RICH evidence transitions to done ──
  it("allows an agent done PATCH when the evidence is RICH", async () => {
    const issue = { ...makeIssue("in_progress"), description: "Fix the login bug.", originKind: null };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "Evidence: merged PR #123 (pull/123), tests 12/12 pass, exit 0" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp(), agentActor(EXECUTOR_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.errorCode).toBeUndefined();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
    expect(doneRejectedCall()).toBeFalsy();
  });

  // ── AC ③ — auto-approval comment with THIN evidence blocks the transition ──
  it("blocks the comment auto-approval transition when evidence is THIN", async () => {
    const policy = (await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }],
        },
      ],
    }))!;
    const issue = {
      ...makeIssue("in_progress"),
      status: "in_review",
      assigneeAgentId: REVIEWER_AGENT_ID,
      description: "",
      originKind: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REVIEWER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: EXECUTOR_AGENT_ID },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-thin-approval",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: THIN_REVIEW_BODY,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: REVIEWER_AGENT_ID,
      authorUserId: null,
    });

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-1",
      }),
    )
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: THIN_REVIEW_BODY });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(doneRejectedCall()).toBeTruthy();
    expect(doneRejectedCall()?.[1]).toMatchObject({
      action: "issue.done_rejected",
      details: expect.objectContaining({ source: "auto_approval_comment" }),
    });
  });

  // ── AC ④ — auto-approval comment with RICH evidence transitions to done ──
  it("allows the comment auto-approval transition when evidence is RICH", async () => {
    const policy = (await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }],
        },
      ],
    }))!;
    const issue = {
      ...makeIssue("in_progress"),
      status: "in_review",
      assigneeAgentId: REVIEWER_AGENT_ID,
      description: "",
      originKind: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REVIEWER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: EXECUTOR_AGENT_ID },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-rich-approval",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: RICH_REVIEW_BODY,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: REVIEWER_AGENT_ID,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const res = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: REVIEWER_AGENT_ID,
        companyId: "company-1",
        source: "agent_key",
        runId: "run-review-1",
      }),
    )
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: RICH_REVIEW_BODY });

    expect(res.status).toBe(201);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
      mockTx,
    );
    expect(doneRejectedCall()).toBeFalsy();
  });

  // ── AC ⑤ — a non-agent (board) actor is exempt: gate never runs ──
  it("exempts non-agent (board) actors from the done evidence gate", async () => {
    const issue = { ...makeIssue("in_progress"), description: "Fix the login bug.", originKind: null };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp()))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.errorCode).toBeUndefined();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
    expect(doneRejectedCall()).toBeFalsy();
  });

  // ── AC ⑥ — a system-writer whitelist origin is exempt: gate never runs ──
  it("exempts system-writer whitelist origins from the done evidence gate", async () => {
    const issue = {
      ...makeIssue("in_progress"),
      description: "Fix the login bug.",
      originKind: "routine_execution",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(await installActor(createApp(), agentActor(EXECUTOR_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.errorCode).toBeUndefined();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
    expect(doneRejectedCall()).toBeFalsy();
  });
});
