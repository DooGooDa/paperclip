import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres concurrent-dispatch single-session tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const EXECUTION_PATH_STATUSES = ["queued", "running", "scheduled_retry"] as const;

describeEmbeddedPostgres("heartbeat concurrent dispatch single-session gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-concurrent-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id → agent_wakeup_requests(id), so runs
    // must be removed before their wakeup requests.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Keep the assignee at its single-run concurrency limit with an unrelated
  // running distractor so the two same-issue wakes queue their runs but never
  // get claimed → the target run stays `queued` for the whole assertion window.
  // This removes the zombie-coalesce window (a freshly-claimed `running` run is
  // briefly untracked by `activeRunExecutions`) so the gate outcome is
  // deterministic, independent of async run execution timing.
  async function seedScenario() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const responsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: responsibleUserId,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // Unrelated running run (no issueId) keeps the agent at its 1-run cap.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: null,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent dispatch race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function activeRunsForIssue(issueId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        and(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          inArray(heartbeatRuns.status, [...EXECUTION_PATH_STATUSES]),
        ),
      );
  }

  async function allRunsForIssue(issueId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`);
  }

  function wakeOpts(issueId: string) {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user" as const,
      requestedByActorId: "local-board",
    };
  }

  it("collapses two concurrent same-issue dispatches into a single active execution session", async () => {
    const { agentId, issueId } = await seedScenario();
    const heartbeat = heartbeatService(db);

    // Two dispatchers race for the same issue at the same instant. The
    // `select ... for update` on the issue row inside enqueueWakeup serializes
    // them; the second caller then observes the first caller's queued run
    // (matched by context_snapshot->>'issueId') and coalesces instead of
    // opening a second session.
    await Promise.all([
      heartbeat.wakeup(agentId, wakeOpts(issueId)),
      heartbeat.wakeup(agentId, wakeOpts(issueId)),
    ]);

    const active = await activeRunsForIssue(issueId);
    expect(active).toHaveLength(1);

    // Exactly one execution run was ever created for the issue — the gate
    // prevented a duplicate session, it did not merely hide one.
    const all = await allRunsForIssue(issueId);
    expect(all).toHaveLength(1);

    // The losing dispatch was coalesced into the winner's run rather than
    // spawning its own.
    const coalesced = await db
      .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      );
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.reason).toBe("issue_execution_same_name");
  });
});
