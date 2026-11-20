/** What {@link ownerTeamIdsOfStepRun} reads, as a `select` on a `WorkflowRun`. */
export const STEP_RUN_OWNER_SELECT = {
  connection: { select: { team: { select: { id: true } } } },
  template: { select: { teamId: true } },
  workRequest: { select: { connection: { select: { team: { select: { id: true } } } } } },
} as const;

interface StepRunOwners {
  connection?: { team: { id: string } } | null;
  template?: { teamId: string | null } | null;
  workRequest?: { connection?: { team: { id: string } } | null } | null;
}

/** The teams that own a step's run: its repository's, its request's repository's and its template's. */
export function ownerTeamIdsOfStepRun(run: StepRunOwners | null): string[] {
  if (!run) {
    return [];
  }
  return [
    ...new Set(
      [run.connection?.team.id, run.workRequest?.connection?.team.id, run.template?.teamId].filter(
        (id): id is string => typeof id === 'string'
      )
    ),
  ];
}
