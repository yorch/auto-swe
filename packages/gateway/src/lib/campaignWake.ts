import { CAMPAIGN_TERMINAL_STATES } from '@auto-swe/shared/lib/campaignOutcome';
import type { FastifyInstance } from 'fastify';

/** The campaign facts a signal to its reconciler needs. */
export interface SignalledCampaign {
  id: string;
  ownerTeamId: string;
  temporalWorkflowId: string;
  workflowKind: string;
}

/** States in which a reconciler is never (re)started: finished, or being cancelled. */
const NEVER_RESTART: readonly string[] = [...CAMPAIGN_TERMINAL_STATES, 'CANCELLING'];

/**
 * Deliver a signal to a reconciled campaign's workflow, starting the workflow when none is
 * running (spec §3: a campaign is recoverable from its rows alone, so a terminated or lost
 * execution is a delay, not the end of the campaign).
 *
 * The campaign row is read here, at the moment of the signal: the restart never goes by the
 * caller's earlier read, so a campaign that finished or began cancelling in between is not
 * started again. A legacy campaign is never started from here. The cancel route does not use this:
 * it signals, and closes the rows itself when the workflow is gone.
 *
 * Throws what the delivery throws; the callers treat a failed delivery as a delay.
 */
export async function signalCampaignReconciler(
  fastify: FastifyInstance,
  campaign: SignalledCampaign,
  signalName: string,
  payload: unknown
): Promise<'signalled' | 'not-running'> {
  if (campaign.workflowKind !== 'RECONCILER') {
    return 'not-running';
  }
  const fresh = await fastify.prisma.campaign.findFirst({
    select: { state: true, workflowKind: true },
    where: { id: campaign.id, ownerTeamId: campaign.ownerTeamId },
  });
  const restartable =
    fresh !== null && fresh.workflowKind === 'RECONCILER' && !NEVER_RESTART.includes(fresh.state);
  return fastify.temporal.signalCampaignWorkflow(
    campaign.temporalWorkflowId,
    signalName,
    payload,
    restartable
      ? { campaignId: campaign.id, campaignWorkflowId: campaign.temporalWorkflowId }
      : undefined
  );
}
