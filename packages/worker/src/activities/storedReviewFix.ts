import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
  agentRunTicketId,
} from '@auto-swe/shared/lib/agentRun';
import { loadAgentRunSlots, wouldAdmitNewRun } from '@auto-swe/shared/lib/agentRunAdmission';
import { orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import type { ReviewRunPayload } from '@auto-swe/shared/lib/codeReview';
import { reviewRunId } from '@auto-swe/shared/lib/reviewLaunch';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { feedbackInjectionScreen, fenceReviewFeedback } from '../lib/ciLogGuard.js';
import { recordWorkerLaunchAudit } from '../lib/launchAudit.js';
import { readReviewFeedback } from '../lib/reviewFeedback.js';
import { loadStoredAgentChange } from '../lib/storedAgentChange.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import type { ReviewFixResult } from './reviewFixes.js';

export async function startStoredReviewFix(
  payload: ReviewRunPayload,
  runId: string,
  attemptId?: string
): Promise<ReviewFixResult> {
  const skip = (reason: string): ReviewFixResult => ({ reason, status: 'skipped' });
  const review = await readReviewFeedback(runId, payload.connectionId);
  if (
    review?.origin !== 'agent_run' ||
    (attemptId && (review.status !== 'SUCCESS' || review.approved !== false))
  ) {
    return skip('no verified stored review target');
  }
  const workflowId = `agent-${payload.connectionId.slice(0, 8)}-${reviewRunId(`${runId}:${attemptId ?? 'initial'}`, 'stored-fix').replace(/-/g, '')}`;
  const workRequestId = reviewRunId(workflowId, 'stored-fix-input');
  const previous = await prisma.activeWorkflow.findUnique({
    include: { workRequest: true },
    where: { temporalWorkflowId: workflowId },
  });
  if (previous?.currentStatus === 'FAILED') {
    return skip('the fix workflow could not start');
  }
  const saved = previous?.workRequest;
  if (saved) {
    const agentPayload =
      saved.payload && typeof saved.payload === 'object' && !Array.isArray(saved.payload)
        ? saved.payload
        : null;
    if (
      !saved.templateId ||
      !saved.templateVersion ||
      !saved.externalTicketId ||
      saved.connectionId !== payload.connectionId ||
      agentPayload?.reviewFixOfRunId !== runId ||
      agentPayload.deliver !== 'none'
    ) {
      return skip('the saved stored fix does not match the review');
    }
    return launchStoredFix(runId, workflowId, workRequestId, {
      request: {
        budgetTier: 'STANDARD',
        connectionId: saved.connectionId,
        description: saved.description,
        externalTicketId: saved.externalTicketId,
        repoId: saved.connectionId,
        ...(saved.requestedById ? { launchedById: saved.requestedById } : {}),
        payload: saved.payload,
        requestPayload: saved.requestPayload ?? JSON.stringify(saved.payload),
        workRequestId,
        workspaceProvider: 'git_repo',
      },
      templateId: saved.templateId,
      templateVersion: saved.templateVersion,
    });
  }
  const source = await loadStoredAgentChange(review.sourceRunId, payload.connectionId);
  if (
    !source.baseSha ||
    !source.agentPayload ||
    review.storedChange?.baseSha !== source.baseSha ||
    review.storedChange.diff !== source.diff
  ) {
    return skip('the source agent parameters are unavailable');
  }
  const repo = await prisma.connection.findUnique({
    include: { team: { include: { organization: true } } },
    where: { id: payload.connectionId },
  });
  if (
    !repo?.isActive ||
    repo.type !== 'git_repo' ||
    !repo.team.isActive ||
    !repo.team.organization.isActive
  ) {
    return skip('repository is unavailable');
  }
  const org = repo.team.organization;
  if (
    org.monthlyBudgetUsdCents !== null &&
    usdToCents((await orgMonthSpend(prisma, org.id)).totalUsd) >= org.monthlyBudgetUsdCents
  ) {
    return skip('the organization is over its monthly budget');
  }
  const template = await prisma.workflowTemplate.findFirst({
    where: {
      name: AGENT_RUN_TEMPLATE_NAME,
      origin: AGENT_RUN_TEMPLATE_ORIGIN,
      status: 'ACTIVE',
      teamId: null,
    },
  });
  if (!template?.activeVersion) {
    return skip('the built-in agent run template is unavailable');
  }
  const settings = await resolveSettings(
    ['workspace.agentRunMaxConcurrentGlobal', 'workspace.agentRunMaxConcurrentPerTeam'],
    { orgId: org.id, teamId: repo.teamId }
  );
  const unusable = await feedbackInjectionScreen(review.texts);
  const findings = review.texts
    .filter((_text, index) => !unusable.has(index))
    .join('\n')
    .slice(0, 6000);
  if (!findings) {
    return skip('no usable stored review findings');
  }
  const agentPayload = {
    ...source.agentPayload,
    deliver: 'none' as const,
    reviewFixOfRunId: runId,
  };
  const description = `${source.description.slice(0, 12_000)}\n\nThe original stored change is already applied. Address the following review findings without publishing a branch or PR.\n${fenceReviewFeedback(findings)}`;
  const launcher = review.launchedById ?? source.launchedById;
  const request: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    connectionId: repo.id,
    description,
    externalTicketId: agentRunTicketId(workRequestId),
    ...(source.agentPayload.egressPolicy ? { egressPolicy: source.agentPayload.egressPolicy } : {}),
    ...(launcher ? { launchedById: launcher } : {}),
    payload: agentPayload,
    repoId: repo.id,
    requestPayload: JSON.stringify(agentPayload),
    workRequestId,
    workspaceProvider: 'git_repo',
  };
  const decision = await prisma.$transaction(async (tx) => {
    // AGENTS.md §7 exception: serialize same-review follow-ups before reserving their ledger slot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stored-review-fix:${runId}`}, 0))`;
    const previous = await tx.activeWorkflow.findUnique({
      where: { temporalWorkflowId: workflowId },
    });
    if (previous) {
      return previous.currentStatus === 'FAILED' ? 'failed' : 'existing';
    }
    const admission = wouldAdmitNewRun(await loadAgentRunSlots(tx, template.id), repo.teamId, {
      global: settings['workspace.agentRunMaxConcurrentGlobal'],
      perTeam: settings['workspace.agentRunMaxConcurrentPerTeam'],
    });
    if (!admission.admitted) {
      return admission.reason === 'disabled' ? 'disabled' : 'busy';
    }
    await tx.runInput.create({
      data: {
        connectionId: repo.id,
        description,
        externalTicketId: request.externalTicketId,
        id: workRequestId,
        knowledgeSourceKind: 'REPOSITORY',
        knowledgeSourceOrgId: org.id,
        knowledgeSourceRepoId: repo.id,
        knowledgeSourceTeamId: repo.teamId,
        payload: agentPayload,
        requestedById: launcher ?? null,
        requestPayload: request.requestPayload,
        templateId: template.id,
        templateVersion: template.activeVersion,
        ticketIsSynthetic: true,
      },
    });
    await tx.activeWorkflow.create({
      data: {
        assignedBranch: null,
        budgetTier: 'STANDARD',
        currentStatus: 'IMPLEMENTING',
        repoId: repo.id,
        temporalWorkflowId: workflowId,
        workRequestId,
      },
    });
    return 'new';
  });
  if (decision === 'disabled') {
    return skip('agent runs are disabled');
  }
  if (decision === 'busy') {
    return skip('agent runs are at their concurrency limit');
  }
  if (decision === 'failed') {
    return skip('the fix workflow could not start');
  }
  return launchStoredFix(runId, workflowId, workRequestId, {
    request,
    templateId: template.id,
    templateVersion: template.activeVersion,
  });
}

async function launchStoredFix(
  runId: string,
  workflowId: string,
  workRequestId: string,
  launch: { request: RepoWorkRequest; templateId: string; templateVersion: number }
): Promise<ReviewFixResult> {
  try {
    await getTemporalClient().workflow.start('RunnableWorkflow', {
      args: [launch],
      taskQueue: 'engineering-workflow',
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'WorkflowExecutionAlreadyStartedError') {
      await prisma.activeWorkflow.updateMany({
        data: { currentStatus: 'FAILED' },
        where: { temporalWorkflowId: workflowId },
      });
      return { reason: 'the fix workflow could not start', status: 'skipped' };
    }
  }
  await recordWorkerLaunchAudit({
    details: { purpose: 'stored-review-fix', reviewRunId: runId, workflowId },
    entityId: workRequestId,
    entityType: 'WorkRequest',
    source: 'code-review',
  });
  return { status: 'started', workflowId, workRequestId };
}
