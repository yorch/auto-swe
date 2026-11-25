import type { CampaignPullRequestChangedSignal } from '@auto-swe/shared/types/workflow';
import { CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../plugins/auth.js';
import { signalCampaignReconciler } from './campaignWake.js';

/** Campaign states in which the reconciler is no longer listening. */
const NOT_LISTENING = ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'];

/**
 * Tell the reconciler of every campaign whose target's latest attempt opened this pull request that
 * it merged, closed or reopened (spec §3, `pullRequestChanged`).
 *
 * The attempt is found through the pull request's run (`PullRequest.runId` against
 * `CampaignAttempt.runId`) or, until the worker has written the attempt's `runId`, through the run's
 * workflow id (`CampaignAttempt.childWorkflowId`); a match writes the missing `runId` onto the
 * attempt. Only an attempt that is still its target's latest counts: an earlier attempt's pull
 * request changing says nothing about the target.
 *
 * Best-effort by construction: the pull request row has been updated and the reconciler's backstop
 * reads it from the database, so this never throws and never fails the webhook. Only ids and the
 * error's name are logged: no response body, header or credential reaches the log.
 */
export async function notifyCampaignsOfPullRequest(
  fastify: FastifyInstance,
  input: {
    runId: string | null;
    workflowId: string | null;
    status: CampaignPullRequestChangedSignal['status'];
  }
): Promise<void> {
  try {
    const matches = [
      ...(input.runId ? [{ runId: input.runId }] : []),
      ...(input.workflowId ? [{ childWorkflowId: input.workflowId }] : []),
    ];
    if (matches.length === 0) {
      return;
    }
    const attempts = await fastify.prisma.campaignAttempt.findMany({
      select: {
        id: true,
        n: true,
        runId: true,
        target: {
          select: {
            campaign: {
              select: {
                id: true,
                ownerTeamId: true,
                state: true,
                temporalWorkflowId: true,
                workflowKind: true,
              },
            },
            id: true,
          },
        },
        targetId: true,
      },
      where: { OR: matches },
    });
    for (const attempt of attempts) {
      const campaign = attempt.target.campaign;
      if (campaign.workflowKind !== 'RECONCILER' || NOT_LISTENING.includes(campaign.state)) {
        continue;
      }
      try {
        const later = await fastify.prisma.campaignAttempt.findFirst({
          select: { id: true },
          where: { n: { gt: attempt.n }, targetId: attempt.targetId },
        });
        if (later) {
          continue;
        }
        if (!attempt.runId && input.runId) {
          await fastify.prisma.campaignAttempt.updateMany({
            data: { runId: input.runId },
            where: { id: attempt.id, runId: null },
          });
        }
        await signalCampaignReconciler(fastify, campaign, CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL, {
          runId: input.runId ?? attempt.runId ?? '',
          status: input.status,
          targetId: attempt.targetId,
        } satisfies CampaignPullRequestChangedSignal);
      } catch (err) {
        fastify.log.warn(
          { campaignId: campaign.id, errName: getErrorName(err), targetId: attempt.targetId },
          'campaign pull request signal not delivered; the reconciler reads it on its backstop pass'
        );
      }
    }
  } catch (err) {
    fastify.log.warn(
      { errName: getErrorName(err) },
      'campaign pull request lookup failed; the reconciler reads the change on its backstop pass'
    );
  }
}
