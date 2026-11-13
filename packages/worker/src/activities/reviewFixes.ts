import type { Prisma } from '@auto-swe/shared';
import {
  decideUnderLock,
  PR_FEEDBACK,
  PrFeedbackFiltersSchema,
  prFeedbackSource,
  repositoryOwnerKey,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { isTeamOverBudget, orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import { matchesPatterns } from '@auto-swe/shared/lib/ciTrigger';
import type { ReviewRunPayload } from '@auto-swe/shared/lib/codeReview';
import { repoHostFamily } from '@auto-swe/shared/lib/githubHostScope';
import {
  PR_FEEDBACK_TEMPLATE_NAME,
  PrFeedbackPayloadSchema,
} from '@auto-swe/shared/lib/prFeedback';
import { reviewFixRetryState, reviewRunId } from '@auto-swe/shared/lib/reviewLaunch';
import { resolveGitHubConfig, resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '@auto-swe/shared/types/api';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { recordWorkerLaunchAudit } from '../lib/launchAudit.js';
import { readReviewFeedback, reviewFeedbackSubject } from '../lib/reviewFeedback.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import { startStoredReviewFix } from './storedReviewFix.js';

export type ReviewFixResult =
  | { status: 'started'; workflowId: string; workRequestId: string }
  | { status: 'skipped'; reason: string };

export async function startReviewFix(
  payload: ReviewRunPayload,
  runId: string,
  attemptId?: string,
  automationId?: string
): Promise<ReviewFixResult> {
  const skip = (reason: string): ReviewFixResult => ({ reason, status: 'skipped' });
  if (payload.onBlocking === 'fix' && payload.reviewOf.mode === 'stored') {
    return startStoredReviewFix(payload, runId, attemptId);
  }
  if (payload.reviewOf.mode !== 'pr' || payload.onBlocking !== 'fix') {
    return skip('fix policy requires a pull request');
  }
  const prNumber = payload.reviewOf.prNumber;
  const review = await readReviewFeedback(runId, payload.connectionId, prNumber);
  if (!review) {
    return skip('no verified stored review target');
  }
  if (attemptId && (review.status !== 'SUCCESS' || review.approved !== false)) {
    return skip('the review is not a successful blocking review');
  }
  const dedupeKey = `review-fix:${runId}${attemptId ? `:${attemptId}` : ''}`;
  const already = await prisma.automationFire.findUnique({ where: { dedupeKey } });
  if (
    already?.outcome === 'STARTED' &&
    already.reason === null &&
    already.temporalWorkflowId &&
    already.workRequestId
  ) {
    return {
      status: 'started',
      workflowId: already.temporalWorkflowId,
      workRequestId: already.workRequestId,
    };
  }
  const repo = await prisma.connection.findUnique({
    include: {
      installation: { select: { host: true, installationId: true, isActive: true } },
      team: { include: { organization: true } },
    },
    where: { id: payload.connectionId },
  });
  if (!repo?.isActive || repo.type !== 'git_repo' || repo.installation?.isActive === false) {
    return skip('repository is unavailable');
  }
  const ctx = { orgId: repo.team.orgId, teamId: repo.teamId };
  if (!(await resolveSetting('github.prFeedbackAutomationsEnabled', ctx))) {
    return skip('pull request feedback automations are switched off');
  }
  const automations = await prisma.automation.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    where: {
      ...(automationId ? { id: automationId } : {}),
      connection: { teamId: repo.teamId },
      connectionId: repo.id,
      enabled: true,
      source: PR_FEEDBACK,
      templateId: null,
    },
  });
  const automation = automations.find((a) => {
    const parsed = PrFeedbackFiltersSchema.safeParse(a.filters);
    return (
      parsed.success &&
      parsed.data.triggers.includes('review_findings') &&
      parsed.data.pullRequests.includes('platform')
    );
  });
  if (!automation) {
    return skip(
      'no enabled repository feedback automation opts in to review_findings with the default template'
    );
  }
  const options = PrFeedbackPayloadSchema.safeParse({
    ...(automation.inputs as object),
    baseBranch: 'placeholder',
    connectionId: repo.id,
    feedbackEventId: runId,
    feedbackEventKind: 'review_findings',
    feedbackOrigin: review.origin,
    feedbackTrigger: 'review_findings',
    pullRequestNumber: prNumber,
  });
  if (!options.success) {
    return skip('the feedback automation has invalid options');
  }
  const ref = toRepoRef(repo);
  const scm = getScmProvider(ref);
  const pr = await scm.pullRequestInfo(ref, prNumber);
  if (pr?.state !== 'open') {
    return skip('the pull request is not open');
  }
  if (
    pr.headRepositoryFullName?.toLowerCase() !==
    `${repo.organizationName}/${repo.repoName}`.toLowerCase()
  ) {
    return skip('the pull request is from a fork');
  }
  if (pr.headSha !== review.headSha) {
    return skip('the reviewed head moved');
  }
  const tracked = await prisma.pullRequest.findFirst({
    include: { workflow: true },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    where: { prNumber, repoId: repo.id, status: 'OPEN' },
  });
  if (
    !tracked?.workflow ||
    (tracked.runId
      ? tracked.runId !== review.sourceRunId
      : tracked.workflow.temporalWorkflowId !== review.sourceWorkflowId)
  ) {
    return skip('the review is not for this platform-opened pull request');
  }
  if (
    tracked.workflow.currentStatus &&
    tracked.workflow.currentStatus !== 'AWAITING_HUMAN_MERGE' &&
    !ACTIVE_WORKFLOW_TERMINAL_STATUSES.has(tracked.workflow.currentStatus as never)
  ) {
    return skip('the source run is still working on the pull request');
  }
  if (pr.headRef === (await scm.defaultBranch(ref))) {
    return skip('the pull request uses the default branch');
  }
  const branch = await scm.branchInfo(ref, pr.headRef);
  if (!branch || branch.protected || branch.sha !== review.headSha) {
    return skip('the reviewed branch moved or is protected');
  }
  const neverPush = await resolveSetting('github.ciFixNeverPushBranches', ctx);
  if (
    matchesPatterns(
      neverPush.map((p) => p.toLowerCase()),
      pr.headRef.toLowerCase()
    )
  ) {
    return skip('the branch is listed as never push');
  }
  const org = repo.team.organization;
  if (
    org.monthlyBudgetUsdCents !== null &&
    usdToCents((await orgMonthSpend(prisma, org.id)).totalUsd) >= org.monthlyBudgetUsdCents
  ) {
    return skip('the organization is over its monthly budget');
  }
  if (await isTeamOverBudget(prisma, repo.teamId, repo.team.monthlyBudgetUsdCents)) {
    return skip('the team that owns the repository is over its monthly budget');
  }
  const template = await prisma.workflowTemplate.findFirst({
    where: { name: PR_FEEDBACK_TEMPLATE_NAME, status: 'ACTIVE', teamId: null },
  });
  if (!template?.activeVersion) {
    return skip('the built-in address-pr-feedback template is unavailable');
  }
  const ownerKey = repositoryOwnerKey(
    repoHostFamily(ref, await resolveGitHubConfig()),
    `${repo.organizationName}/${repo.repoName}`
  );
  const subjectKey = reviewFeedbackSubject(prNumber, runId, attemptId);
  const scopeKey = `pr-${prNumber}`;
  const workflowId = `prfb-review-${runId}${attemptId ? `-${attemptId}` : ''}`;
  const workRequestId = reviewRunId(workflowId, 'review-fix-input');
  const ticket = workflowId;
  const { branchPrefix } = await resolveWorkflowDefaults();
  const workBranch = `${branchPrefix}/${ticket}`;
  const feedbackPayload = { ...options.data, baseBranch: pr.headRef };
  const description = `Address stored findings from review run ${runId} on pull request #${prNumber}.`;
  const request: RepoWorkRequest = {
    branchName: workBranch,
    budgetTier: 'STANDARD',
    connectionId: repo.id,
    description,
    externalTicketId: ticket,
    payload: feedbackPayload,
    repoId: repo.id,
    requestPayload: JSON.stringify(feedbackPayload),
    // Provenance: the fix of the reviewed run `runId`. No initiator is carried to this activity.
    trigger: 'review-fix',
    triggerRefId: runId,
    workRequestId,
    workspaceProvider: 'git_repo',
  };
  const client = getTemporalClient();
  const decision = await prisma.$transaction(async (tx) => {
    const previous = await tx.automationFire.findUnique({ where: { dedupeKey } });
    if (previous) {
      return previous.outcome === 'STARTED'
        ? { ready: previous.reason === null, status: 'existing' as const }
        : {
            reason: previous.reason ?? 'the review fix was already decided',
            status: 'skipped' as const,
          };
    }
    const blocked = await decideUnderLock(
      tx,
      { automation, ownerKey },
      prFeedbackSource,
      { scope: scopeKey, subject: subjectKey },
      new Date(),
      async (id) => (await client.workflow.getHandle(id).describe()).status.name !== 'RUNNING'
    );
    const raced = await tx.automationFire.findUnique({ where: { dedupeKey } });
    if (raced) {
      return raced.outcome === 'STARTED'
        ? { ready: raced.reason === null, status: 'existing' as const }
        : {
            reason: raced.reason ?? 'the review fix was already decided',
            status: 'skipped' as const,
          };
    }
    const pushed = await tx.automationFire.count({
      where: {
        outcome: 'STARTED',
        ownerKey,
        producedKey: { not: null },
        scopeKey,
        source: PR_FEEDBACK,
      },
    });
    const reason =
      blocked?.reason ?? (pushed >= feedbackPayload.maxRounds ? 'round limit reached' : null);
    await tx.automationFire.create({
      data: {
        automationId: automation.id,
        connectionId: repo.id,
        dedupeKey,
        facts: {
          headSha: review.headSha,
          reviewRunId: runId,
          ...(attemptId ? { reviewFixAttemptId: attemptId } : {}),
        },
        outcome: blocked?.outcome ?? (reason ? 'SUPPRESSED_PRECONDITION' : 'STARTED'),
        ownerKey,
        reason: reason ?? 'starting',
        scopeKey,
        source: PR_FEEDBACK,
        subjectKey,
        ...(reason ? {} : { temporalWorkflowId: workflowId, workRequestId }),
      },
    });
    if (reason) {
      return { reason, status: 'skipped' as const };
    }
    await tx.runInput.create({
      data: {
        connectionId: repo.id,
        description,
        externalTicketId: ticket,
        id: workRequestId,
        knowledgeSourceKind: 'REPOSITORY',
        knowledgeSourceOrgId: repo.team.orgId,
        knowledgeSourceRepoId: repo.id,
        knowledgeSourceTeamId: repo.teamId,
        payload: feedbackPayload,
        requestPayload: JSON.stringify(feedbackPayload),
        templateId: template.id,
        templateVersion: template.activeVersion,
        ticketIsSynthetic: true,
        workBranch,
      },
    });
    await tx.activeWorkflow.create({
      data: {
        assignedBranch: workBranch,
        budgetTier: 'STANDARD',
        currentStatus: 'IMPLEMENTING',
        repoId: repo.id,
        temporalWorkflowId: workflowId,
        workRequestId,
      },
    });
    return { status: 'new' as const };
  });
  if (decision.status === 'skipped') {
    return skip(decision.reason);
  }
  if (decision.status === 'existing' && decision.ready) {
    return { status: 'started', workflowId, workRequestId };
  }
  let launch = { request, templateId: template.id, templateVersion: template.activeVersion };
  if (decision.status === 'existing') {
    const saved = await prisma.runInput.findUnique({ where: { id: workRequestId } });
    const savedPayload = PrFeedbackPayloadSchema.safeParse(saved?.payload);
    if (
      !saved?.templateId ||
      !saved.templateVersion ||
      !savedPayload.success ||
      savedPayload.data.connectionId !== repo.id ||
      savedPayload.data.feedbackEventId !== runId ||
      savedPayload.data.feedbackTrigger !== 'review_findings'
    ) {
      return skip('the saved feedback launch is unavailable');
    }
    launch = {
      request: {
        ...request,
        branchName: saved.workBranch ?? request.branchName,
        description: saved.description,
        externalTicketId: saved.externalTicketId,
        payload: savedPayload.data,
        requestPayload: saved.requestPayload,
      },
      templateId: saved.templateId,
      templateVersion: saved.templateVersion,
    };
  }
  try {
    await client.workflow.start('RunnableWorkflow', {
      args: [launch],
      taskQueue: 'engineering-workflow',
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'WorkflowExecutionAlreadyStartedError') {
      await prisma.automationFire.update({
        data: { outcome: 'FAILED_TO_START', reason: 'the fix workflow could not start' },
        where: { dedupeKey },
      });
      return skip('the fix workflow could not start');
    }
  }
  await prisma.automationFire.update({ data: { reason: null }, where: { dedupeKey } });
  await recordWorkerLaunchAudit({
    details: { automationId: automation.id, purpose: 'fix', reviewRunId: runId, workflowId },
    entityId: workRequestId,
    entityType: 'WorkRequest',
    source: 'code-review',
  });
  return { status: 'started', workflowId, workRequestId };
}

export async function retryReviewFix(input: {
  runId: string;
  attemptId: string;
  automationId?: string;
}): Promise<ReviewFixResult> {
  const state = await reviewFixRetryState(prisma, input.runId);
  if (!state.allowed || state.attemptId !== input.attemptId) {
    return { reason: 'The fix decision is no longer retryable', status: 'skipped' as const };
  }
  let result: ReviewFixResult;
  try {
    result = await startReviewFix(state.payload, input.runId, input.attemptId, input.automationId);
  } catch {
    result = { reason: 'the fix launch failed', status: 'skipped' };
  }
  await prisma.workflowStep.update({
    data: {
      outputs: {
        ...state.summary,
        fix: {
          ...result,
          attemptId: input.attemptId,
          decidedAt: new Date().toISOString(),
        },
        fixRetry: { attemptId: input.attemptId, status: 'completed' },
      } as Prisma.InputJsonObject,
    },
    where: { id: state.step.id },
  });
  return result;
}
