import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { logActivity } from "./activity-log.js";
import { logDoneGateBypass } from "./issue-done-gate-audit.js";

const mockedLogActivity = vi.mocked(logActivity);

describe("logDoneGateBypass", () => {
  beforeEach(() => {
    mockedLogActivity.mockClear();
  });

  it("emits issue.done_gate_bypassed with system actor, reason and origin", async () => {
    const db = { marker: "db-handle" } as unknown as Parameters<typeof logDoneGateBypass>[0];
    await logDoneGateBypass(db, {
      companyId: "company-1",
      issueId: "issue-1",
      issueIdentifier: "DGG-42",
      previousStatus: "in_progress",
      reason: "recovery.reconcile_stranded_recovery_issue_auto_done",
      agentId: "agent-9",
      runId: "run-7",
      originKind: "stranded_issue_recovery",
    });

    expect(mockedLogActivity).toHaveBeenCalledTimes(1);
    const [passedDb, arg] = mockedLogActivity.mock.calls[0] as [unknown, Record<string, any>];
    expect(passedDb).toBe(db);
    expect(arg).toMatchObject({
      companyId: "company-1",
      actorType: "system",
      actorId: "system",
      agentId: "agent-9",
      runId: "run-7",
      action: "issue.done_gate_bypassed",
      entityType: "issue",
      entityId: "issue-1",
    });
    expect(arg.details).toMatchObject({
      status: "done",
      gate: "done_evidence",
      reason: "recovery.reconcile_stranded_recovery_issue_auto_done",
      originKind: "stranded_issue_recovery",
      identifier: "DGG-42",
      previousStatus: "in_progress",
    });
  });

  it("defaults actor to system and nullable fields to null", async () => {
    await logDoneGateBypass({} as unknown as Parameters<typeof logDoneGateBypass>[0], {
      companyId: "company-2",
      issueId: "issue-2",
      reason: "heartbeat.routine_execution_run_finalized",
    });

    const arg = mockedLogActivity.mock.calls[0]?.[1] as Record<string, any>;
    expect(arg.actorType).toBe("system");
    expect(arg.actorId).toBe("system");
    expect(arg.agentId).toBeNull();
    expect(arg.runId).toBeNull();
    expect(arg.details.originKind).toBeNull();
    expect(arg.details.identifier).toBeNull();
    expect(arg.details.previousStatus).toBeNull();
    expect(arg.action).toBe("issue.done_gate_bypassed");
  });
});
