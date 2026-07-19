import { and, desc, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import {
  classifyFailure,
  countExecutionChangesRequestedWakes,
  type FailureClass,
} from "@paperclipai/shared";

/**
 * A read-only view of an issue's most recent failure, assembled from the
 * canonical failure store (heartbeat_runs) plus its execution-retry wake count.
 *
 * Downstream retry-memory logic (E10 T10.2/T10.3/T10.6) consumes this record to
 * decide whether — and how — to re-dispatch a failed issue. The classification
 * itself lives in @paperclipai/shared so it is unit-tested without a database;
 * this service is the DB shell that gathers the inputs and delegates.
 */
export interface IssueFailureRecord {
  issueId: string;
  /** Error text of the most recent failing run, or null if none is recorded. */
  lastError: string | null;
  /** Structured error code of that run (heartbeat_runs.error_code), or null. */
  errorCode: string | null;
  /** Failure class derived from the run's error + wake context. */
  failureClass: FailureClass;
  /**
   * Number of "changes requested" (execution_changes_requested) wakes for this
   * issue. This deliberately excludes C2 self-comment (missing_issue_comment),
   * bounded transient retries, and monitor/watchdog wakes.
   */
  attemptCount: number;
  /** When the most recent failing run finished (falls back to its created_at). */
  lastAttemptAt: Date | null;
}

// A heartbeat run counts as "failing" when it ended in a terminal failure state
// or carries a non-null error. Statuses mirror the heartbeat terminal set.
const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;

function readSnapshotString(
  snapshot: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = snapshot?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Read the failure record for an issue.
 *
 * Runs are linked to an issue through context_snapshot.issueId (also mirrored
 * to context_snapshot.taskId); wakes through payload.issueId (also mirrored to
 * payload._paperclipWakeContext.issueId), matching the existing task-watchdog
 * and routine linkage conventions.
 */
export async function getIssueFailureRecord(db: Db, issueId: string): Promise<IssueFailureRecord> {
  const runIssueMatch = or(
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
    sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueId}`,
  );

  const [lastFailure] = await db
    .select({
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        runIssueMatch,
        or(
          sql`${heartbeatRuns.status} in ('failed', 'timed_out')`,
          isNotNull(heartbeatRuns.error),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt})`))
    .limit(1);

  // Fetch the wake reasons for this issue and count in the shared, fixture-proven
  // helper — the single source of truth for what counts as an execution attempt.
  const wakeIssueMatch = or(
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issueId}`,
  );
  const wakes = await db
    .select({ reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests)
    .where(wakeIssueMatch);
  const attemptCount = countExecutionChangesRequestedWakes(wakes);

  const context = {
    wakeReason: readSnapshotString(lastFailure?.contextSnapshot, "wakeReason"),
    source: readSnapshotString(lastFailure?.contextSnapshot, "source"),
  };

  return {
    issueId,
    lastError: lastFailure?.error ?? null,
    errorCode: lastFailure?.errorCode ?? null,
    failureClass: classifyFailure(lastFailure?.error ?? null, lastFailure?.errorCode ?? null, context),
    attemptCount,
    lastAttemptAt: lastFailure?.finishedAt ?? lastFailure?.createdAt ?? null,
  };
}

export { FAILED_RUN_STATUSES };
