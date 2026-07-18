import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres duplicate-active-session detector tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery detectDuplicateActiveIssueSessions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-duplicate-active-sessions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBase() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertIssue(companyId: string, agentId: string, issueId: string, title: string) {
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
  }

  async function insertRun(
    companyId: string,
    agentId: string,
    issueId: string | null,
    status: string,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: issueId ? { issueId } : null,
    });
    return runId;
  }

  it("detects an issue holding more than one active execution session", async () => {
    const { companyId, agentId } = await seedBase();
    const issueId = randomUUID();
    await insertIssue(companyId, agentId, issueId, "Duplicate active sessions");
    const runningRunId = await insertRun(companyId, agentId, issueId, "running");
    const queuedRunId = await insertRun(companyId, agentId, issueId, "queued");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.detectDuplicateActiveIssueSessions();

    expect(result.detected).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const audit = await db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.duplicate_active_sessions"))
      .then((rows) => rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(issueId);
    const details = audit[0]?.details as {
      activeCount?: number;
      activeRunIds?: string[];
    } | null;
    expect(details?.activeCount).toBe(2);
    expect([...(details?.activeRunIds ?? [])].sort()).toEqual([queuedRunId, runningRunId].sort());
  });

  it("does not flag an issue with a single active session (other runs terminal)", async () => {
    const { companyId, agentId } = await seedBase();
    const issueId = randomUUID();
    await insertIssue(companyId, agentId, issueId, "Single active session");
    await insertRun(companyId, agentId, issueId, "running");
    await insertRun(companyId, agentId, issueId, "succeeded");
    await insertRun(companyId, agentId, issueId, "failed");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.detectDuplicateActiveIssueSessions();

    expect(result.detected).toBe(0);
    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.duplicate_active_sessions"))
      .then((rows) => rows);
    expect(audit).toHaveLength(0);
  });

  it("counts scheduled_retry as active and ignores runs without an issueId", async () => {
    const { companyId, agentId } = await seedBase();
    const issueId = randomUUID();
    await insertIssue(companyId, agentId, issueId, "running + scheduled_retry");
    await insertRun(companyId, agentId, issueId, "running");
    await insertRun(companyId, agentId, issueId, "scheduled_retry");
    // Two active runs with no issueId must not be grouped/flagged.
    await insertRun(companyId, agentId, null, "running");
    await insertRun(companyId, agentId, null, "queued");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.detectDuplicateActiveIssueSessions();

    expect(result.detected).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });
});
