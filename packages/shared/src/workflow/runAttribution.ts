export interface RunAttributionTeam {
  id: string;
  orgId: string;
}

type TeamRelation = { team: RunAttributionTeam | null } | null | undefined;

export interface WorkflowRunAttributionSources {
  activeWorkflowRepoId?: string | null;
  connectionId?: string | null;
  connection?: TeamRelation;
  workRequest?: {
    billingOrgId?: string | null;
    /** The team a connection-less launch was held to: the last source of the run's team. */
    billingTeam?: RunAttributionTeam | null;
    connection?: TeamRelation;
    requestedByService?: TeamRelation;
  } | null;
  channel?: TeamRelation;
  template?: TeamRelation;
}

export interface WorkflowRunAttribution {
  attributedTeamId: string | null;
  attributedOrgId: string | null;
  attributedRepoId: string | null;
}

export const attributionTeamSelect = {
  id: true,
  orgId: true,
} as const;

export const attributionTeamRelationSelect = {
  team: { select: attributionTeamSelect },
} as const;

export const runInputAttributionSelect = {
  billingOrgId: true,
  billingTeam: { select: attributionTeamSelect },
  connection: { select: attributionTeamRelationSelect },
  requestedByService: { select: attributionTeamRelationSelect },
} as const;

export function resolveWorkflowRunAttribution(
  sources: WorkflowRunAttributionSources
): WorkflowRunAttribution {
  const team =
    sources.connection?.team ??
    sources.workRequest?.connection?.team ??
    sources.channel?.team ??
    sources.workRequest?.requestedByService?.team ??
    sources.template?.team ??
    // Last: a launch with no repository, channel, service principal or template team (a team
    // automation on a global template) still spends the team whose cap gated it.
    sources.workRequest?.billingTeam ??
    null;

  return {
    attributedOrgId: team?.orgId ?? sources.workRequest?.billingOrgId ?? null,
    attributedRepoId: sources.activeWorkflowRepoId ?? sources.connectionId ?? null,
    attributedTeamId: team?.id ?? null,
  };
}
