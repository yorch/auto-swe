import type {
  CampaignTargetInput,
  CampaignWorkflowInput,
  RepoWorkRequest,
} from '@auto-swe/shared/types/workflow';

/**
 * The start input of one campaign child: what `CampaignWorkflow` hands `RunnableWorkflow` for one
 * target. Pure and type-only in its imports, so the workflow isolate can use it and a unit test can
 * measure it.
 *
 * Every child start is an event in the campaign's history, so this carries only what the child
 * reads: the brief (its agent and pull-request steps read `request.description`), the payload, and
 * the identifiers. The launch request itself lives once, on the campaign's `RunInput` row; the
 * child's `requestPayload` is its own small payload, not a copy of that request.
 */
export function campaignChildArgs(
  input: Pick<
    CampaignWorkflowInput,
    | 'campaignWorkflowId'
    | 'childPayload'
    | 'description'
    | 'externalTicketId'
    | 'launchedById'
    | 'templateId'
    | 'templateVersion'
    | 'workRequestId'
  >,
  target: Pick<CampaignTargetInput, 'connectionId'>
): { request: RepoWorkRequest; templateId: string; templateVersion: number } {
  const payload = { ...input.childPayload, connectionId: target.connectionId };
  return {
    request: {
      connectionId: target.connectionId,
      description: input.description,
      externalTicketId: input.externalTicketId,
      launchedById: input.launchedById,
      parentWorkflowId: input.campaignWorkflowId,
      payload,
      repoId: target.connectionId,
      requestPayload: JSON.stringify(payload),
      workRequestId: input.workRequestId,
    },
    templateId: input.templateId,
    templateVersion: input.templateVersion,
  };
}
