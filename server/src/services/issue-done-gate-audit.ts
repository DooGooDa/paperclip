import { logActivity } from "./activity-log.js";

/**
 * Records an `issue.done_gate_bypassed` audit event for a system-writer code path
 * that transitions an issue to `done` WITHOUT passing the route-level done-evidence
 * gate (PATCH `/issues/:id` + comment auto-approval, added in E6 T6.3).
 *
 * These paths — recovery reconciliation and routine-run finalization — are
 * intentional, whitelisted bypasses: they are machine-driven state reconciliations
 * for which agent-authored completion evidence is not meaningful. Emitting a
 * distinct, queryable marker keeps every gate bypass observable, so the E6 bypass
 * audit can tell a whitelisted system write apart from an unaccounted (potentially
 * illicit) done write that skipped the gate entirely.
 */
export async function logDoneGateBypass(
  dbOrTx: Parameters<typeof logActivity>[0],
  input: {
    companyId: string;
    issueId: string;
    /** Stable identifier of the writing path, e.g. `recovery.reconcile_stranded_recovery_issue_auto_done`. */
    reason: string;
    actorType?: "user" | "agent" | "system" | "plugin";
    actorId?: string;
    agentId?: string | null;
    runId?: string | null;
    originKind?: string | null;
    issueIdentifier?: string | null;
    previousStatus?: string | null;
  },
): Promise<void> {
  await logActivity(dbOrTx, {
    companyId: input.companyId,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? "system",
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    action: "issue.done_gate_bypassed",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      status: "done",
      gate: "done_evidence",
      reason: input.reason,
      originKind: input.originKind ?? null,
      identifier: input.issueIdentifier ?? null,
      previousStatus: input.previousStatus ?? null,
    },
  });
}
