export interface RunAttributionTeam {
  id: string;
  orgId: string;
}

type TeamRelation = { team: RunAttributionTeam | null } | null | undefined;

export interface WorkflowRunAttributionSources {
  connection?: TeamRelation;
  workRequest?: {
    billingOrgId?: string | null;
    connection?: TeamRelation;
    requestedByService?: TeamRelation;
  } | null;
  channel?: TeamRelation;
  template?: TeamRelation;
}

export interface WorkflowRunAttribution {
  attributedTeamId: string | null;
  attributedOrgId: string | null;
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
    null;

  return {
    attributedOrgId: team?.orgId ?? sources.workRequest?.billingOrgId ?? null,
    attributedTeamId: team?.id ?? null,
  };
}
