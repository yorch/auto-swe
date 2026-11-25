import { ApplicationFailure, activityInfo } from '@temporalio/activity';

/**
 * A campaign's workflow id is `campaign-<campaignId>`, and the reconciler's activities write the
 * campaign's rows. Nothing in a workflow's input proves the two belong together: whoever can start
 * a workflow on the task queue chooses both. So an activity that reads or writes a campaign refuses
 * unless the workflow that scheduled it is the one the campaign owns, the way the orchestration's
 * activities do (`orchestrationIdentity.ts`). The check lives in the activity, not the workflow, so
 * replaying histories recorded under other ids stays deterministic.
 */

/** Non-retryable refusal type, so the workflow fails at once instead of retrying. */
export const CAMPAIGN_WORKFLOW_MISMATCH = 'CAMPAIGN_WORKFLOW_MISMATCH';

export function campaignWorkflowIdOf(campaignId: string): string {
  return `campaign-${campaignId}`;
}

/** Throw unless `workflowId` is the workflow id the campaign owns. */
export function assertOwnCampaignWorkflowId(campaignId: string, workflowId: string): void {
  if (workflowId !== campaignWorkflowIdOf(campaignId)) {
    throw ApplicationFailure.nonRetryable(
      'This workflow is not the one that owns the campaign',
      CAMPAIGN_WORKFLOW_MISMATCH
    );
  }
}

/**
 * {@link assertOwnCampaignWorkflowId} for the workflow that scheduled the running activity. Outside
 * an activity (a unit test calling the function directly) there is no workflow to judge and nothing
 * is checked; inside one, a missing workflow id is a refusal.
 */
export function assertCurrentWorkflowOwnsCampaign(campaignId: string): void {
  let info: ReturnType<typeof activityInfo>;
  try {
    info = activityInfo();
  } catch {
    return;
  }
  assertOwnCampaignWorkflowId(campaignId, info.workflowExecution?.workflowId ?? '');
}
