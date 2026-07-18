type MaybeId = string | null | undefined;

export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId) return input.goalId;
  // Explicit unattached intent: client sent both projectId=null and goalId=null.
  // Do not auto-attach the default company goal in this case so that callers
  // (e.g., daily smoke drills) can create truly unattached issues without
  // polluting unrelated goals. Omitted (undefined) keys keep the legacy
  // default-goal fallback behavior for normal issue creation flows.
  if (input.goalId === null && input.projectId === null) return null;
  if (input.projectId) return input.projectGoalId ?? null;
  return input.defaultGoalId ?? null;
}

export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  currentProjectGoalId?: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const projectGoalId =
    input.projectGoalId !== undefined
      ? input.projectGoalId
      : projectId
        ? input.currentProjectGoalId
        : null;

  const resolveFallbackGoalId = (targetProjectId: MaybeId, targetProjectGoalId: MaybeId) => {
    if (targetProjectId) return targetProjectGoalId ?? null;
    return input.defaultGoalId ?? null;
  };

  if (input.goalId !== undefined) {
    return input.goalId ?? resolveFallbackGoalId(projectId, projectGoalId);
  }

  const currentFallbackGoalId = resolveFallbackGoalId(
    input.currentProjectId,
    input.currentProjectGoalId,
  );
  const nextFallbackGoalId = resolveFallbackGoalId(projectId, projectGoalId);

  if (!input.currentGoalId) {
    return nextFallbackGoalId;
  }

  if (input.currentGoalId === currentFallbackGoalId) {
    return nextFallbackGoalId;
  }

  return input.currentGoalId;
}
