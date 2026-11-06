import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import {
  prepareReviewLaunch,
  ReviewLaunchError,
  recordReviewLaunch,
} from '@auto-swe/shared/lib/reviewLaunch';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { logWarn } from '../lib/activityLog.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { recordWorkerLaunchAudit } from '../lib/launchAudit.js';
import { getTemporalClient } from '../lib/temporalClient.js';

export interface ReviewIntentSource {
  id: string;
  templateId: string;
  templateKind?: string | null;
  reviewOfRunId?: string | null;
  connectionId?: string | null;
  teamId?: string;
  orgId?: string;
}

export async function enqueueReviewLaunchIntents(
  tx: Prisma.TransactionClient,
  source: ReviewIntentSource,
  status: string
): Promise<void> {
  if (
    status !== 'SUCCESS' ||
    !source.templateId ||
    source.templateKind === 'review' ||
    source.reviewOfRunId
  ) {
    return;
  }
  if (!(await resolveSetting('review.enabled', { orgId: source.orgId, teamId: source.teamId }))) {
    return;
  }
  const attachments = await tx.reviewPresetAttachment.findMany({
    select: { presetId: true },
    where: {
      OR: [
        { templateId: source.templateId },
        ...(source.connectionId ? [{ connectionId: source.connectionId }] : []),
      ],
      preset: {
        enabled: true,
        OR: [{ teamId: null }, ...(source.teamId ? [{ teamId: source.teamId }] : [])],
      },
    },
  });
  const presets = [...new Set(attachments.map((a) => a.presetId))];
  if (presets.length) {
    await tx.reviewLaunchIntent.createMany({
      data: presets.map((presetId) => ({ presetId, sourceRunId: source.id })),
      skipDuplicates: true,
    });
  }
}

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export async function dispatchReviewLaunches(runId: string): Promise<void> {
  return withHeartbeat('dispatchReviewLaunches', dispatch(runId));
}

async function dispatch(runId: string): Promise<void> {
  const stale = new Date(Date.now() - LEASE_MS);
  const intents = await prisma.reviewLaunchIntent.findMany({
    orderBy: { createdAt: 'asc' },
    take: 50,
    where: {
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ attempts: 0 }, { updatedAt: { lt: stale } }],
      sourceRunId: runId,
      status: { in: ['pending', 'failed'] },
    },
  });
  for (const intent of intents) {
    const claimed = await prisma.reviewLaunchIntent.updateMany({
      data: {
        attempts: { increment: 1 },
        reason: 'dispatching',
        status: 'pending',
        updatedAt: new Date(),
      },
      where: {
        attempts: intent.attempts,
        id: intent.id,
        status: intent.status,
        updatedAt: intent.updatedAt,
      },
    });
    if (!claimed.count) {
      continue;
    }
    try {
      const source = await prisma.workflowRun.findUniqueOrThrow({
        select: { launchedById: true },
        where: { id: runId },
      });
      const prepared = await prepareReviewLaunch(prisma, {
        launchedById: source.launchedById,
        nonceHex: intent.id.replace(/-/g, ''),
        presetId: intent.presetId,
        sourceRunId: runId,
      });
      const org = await prisma.organization.findUnique({
        select: { monthlyBudgetUsdCents: true },
        where: { id: prepared.repo.team.orgId },
      });
      if (
        org?.monthlyBudgetUsdCents != null &&
        usdToCents((await orgMonthSpend(prisma, prepared.repo.team.orgId)).totalUsd) >=
          org.monthlyBudgetUsdCents
      ) {
        throw new ReviewLaunchError('REVIEW_BUDGET_EXCEEDED', 'Organization budget is exhausted');
      }
      const launch = await recordReviewLaunch(prisma, prepared);
      try {
        await getTemporalClient().workflow.start('RunnableWorkflow', {
          args: [launch],
          taskQueue: 'engineering-workflow',
          workflowId: prepared.workflowId,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'WorkflowExecutionAlreadyStartedError') {
          throw err;
        }
      }
      const review = await prisma.workflowRun.findUnique({
        select: { id: true },
        where: { workflowId: prepared.workflowId },
      });
      await prisma.reviewLaunchIntent.update({
        data: { reason: null, status: 'started', ...(review ? { reviewRunId: review.id } : {}) },
        where: { id: intent.id },
      });
      await recordWorkerLaunchAudit({
        actorId: source.launchedById,
        details: { presetId: intent.presetId, sourceRunId: runId, workflowId: prepared.workflowId },
        entityId: prepared.request.workRequestId,
        entityType: 'WorkRequest',
        source: 'code-review',
      });
    } catch (err) {
      await prisma.reviewLaunchIntent.update({
        data: {
          reason: err instanceof ReviewLaunchError ? err.code : 'REVIEW_LAUNCH_FAILED',
          status: err instanceof ReviewLaunchError ? 'skipped' : 'failed',
        },
        where: { id: intent.id },
      });
      logWarn('automatic review launch did not start', {
        intentId: intent.id,
        reason: err instanceof ReviewLaunchError ? err.code : 'REVIEW_LAUNCH_FAILED',
        sourceRunId: runId,
      });
    }
  }
}

export async function sweepReviewLaunches(now = new Date()): Promise<void> {
  await prisma.reviewLaunchIntent.updateMany({
    data: { reason: 'REVIEW_LAUNCH_ATTEMPTS_EXHAUSTED', status: 'failed' },
    where: {
      attempts: { gte: MAX_ATTEMPTS },
      status: 'pending',
      updatedAt: { lt: new Date(now.getTime() - LEASE_MS) },
    },
  });
  const pending = await prisma.reviewLaunchIntent.findMany({
    distinct: ['sourceRunId'],
    orderBy: { updatedAt: 'asc' },
    select: { sourceRunId: true },
    take: 50,
    where: {
      attempts: { lt: MAX_ATTEMPTS },
      status: { in: ['pending', 'failed'] },
      updatedAt: { lt: new Date(now.getTime() - LEASE_MS) },
    },
  });
  for (const row of pending) {
    await dispatchReviewLaunches(row.sourceRunId);
  }
}
