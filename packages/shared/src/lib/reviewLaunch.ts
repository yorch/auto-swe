import { createHash, randomBytes } from 'node:crypto';
import { resolveSetting } from '../config/index.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { RepoWorkRequest } from '../types/workflow.js';
import { AGENT_RUN_TEMPLATE_ORIGIN } from './agentRun.js';
import {
  type ReviewRunPayload,
  ReviewRunPayloadSchema,
  type ReviewSourceFacts,
  resolveReviewOf,
  reviewWorkflowId,
} from './codeReview.js';

export class ReviewLaunchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

export function reviewRunId(workflowId: string, purpose = 'run'): string {
  const hex = createHash('sha256').update(`${purpose}:${workflowId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function loadReviewSource(db: PrismaClient, sourceRunId: string) {
  const source = await db.workflowRun.findUnique({
    include: {
      steps: { orderBy: [{ startedAt: 'desc' }, { attempt: 'desc' }], where: { status: 'PASSED' } },
      template: { select: { kind: true, origin: true, teamId: true } },
      workRequest: { select: { connectionId: true } },
    },
    where: { id: sourceRunId },
  });
  if (!source) {
    throw new ReviewLaunchError('REVIEW_SOURCE_NOT_FOUND', 'Source run not found', 404);
  }
  const snapshot = object(source.contextSnapshot);
  const context = object(snapshot.context);
  const outputs = source.steps.map((step) => object(step.outputs));
  const candidates = [
    object(context.currentCodeResult),
    object(snapshot.result),
    ...outputs.flatMap((out) => [object(out.codeResult), out]),
  ];
  const code = candidates.find(
    (c) => typeof c.branch === 'string' && typeof c.headSha === 'string'
  );
  const stored = candidates.find((c) => c.deliver === 'none' && typeof c.diff === 'string');
  const pr = await db.pullRequest.findFirst({
    orderBy: { updatedAt: 'desc' },
    where: {
      OR: [
        { runId: source.id },
        { runId: null, workflow: { temporalWorkflowId: source.workflowId } },
      ],
      status: 'OPEN',
    },
  });
  const facts: ReviewSourceFacts = {
    codeResult: code
      ? {
          branch: String(code.branch),
          headSha: String(code.headSha),
          ...(typeof code.baseBranch === 'string' ? { baseBranch: code.baseBranch } : {}),
        }
      : null,
    deliver: stored?.deliver as string | undefined,
    isAgentRun:
      source.template.origin === AGENT_RUN_TEMPLATE_ORIGIN && source.template.teamId === null,
    pullRequest: pr ? { prNumber: pr.prNumber, status: pr.status } : null,
    reviewOfRunId: source.reviewOfRunId,
    status: source.status,
    storedDiff: stored?.diff as string | undefined,
    templateKind: source.template.kind,
  };
  const connectionId =
    source.connectionId ??
    source.workRequest?.connectionId ??
    (
      await db.activeWorkflow.findUnique({
        select: { repoId: true },
        where: { temporalWorkflowId: source.workflowId },
      })
    )?.repoId;
  return { connectionId, facts, source };
}

export interface PrepareReviewInput {
  sourceRunId: string;
  presetId?: string;
  templateId?: string;
  launchedById?: string | null;
  nonceHex?: string;
}

export async function prepareReviewLaunch(db: PrismaClient, input: PrepareReviewInput) {
  if (!!input.presetId === !!input.templateId) {
    throw new ReviewLaunchError(
      'REVIEW_TEMPLATE_INVALID',
      'Choose exactly one preset or review template',
      400
    );
  }
  const { source, connectionId, facts } = await loadReviewSource(db, input.sourceRunId);
  const resolved = resolveReviewOf(facts);
  if (!resolved.ok) {
    throw new ReviewLaunchError(resolved.code, 'Source run cannot be reviewed');
  }
  if (!connectionId) {
    throw new ReviewLaunchError('REVIEW_NOTHING_TO_REVIEW', 'Source run has no repository');
  }
  const repo = await db.connection.findUnique({
    include: { team: { select: { orgId: true } } },
    where: { id: connectionId },
  });
  if (!repo?.isActive || repo.type !== 'git_repo') {
    throw new ReviewLaunchError('REVIEW_NOTHING_TO_REVIEW', 'Source repository is unavailable');
  }
  if (!(await resolveSetting('review.enabled', { orgId: repo.team.orgId, teamId: repo.teamId }))) {
    throw new ReviewLaunchError('REVIEW_DISABLED', 'Reviews are disabled for this repository');
  }
  const preset = input.presetId
    ? await db.reviewPreset.findUnique({ where: { id: input.presetId } })
    : null;
  if (input.presetId && !preset?.enabled) {
    throw new ReviewLaunchError('REVIEW_PRESET_DISABLED', 'Review preset is missing or disabled');
  }
  const templateId = preset?.templateId ?? input.templateId;
  if (!templateId) {
    throw new ReviewLaunchError('REVIEW_TEMPLATE_INVALID', 'Review template is missing');
  }
  const template = await db.workflowTemplate.findUnique({ where: { id: templateId } });
  if (template?.kind !== 'review' || template.status !== 'ACTIVE' || !template.activeVersion) {
    throw new ReviewLaunchError('REVIEW_TEMPLATE_INVALID', 'Choose an active review-kind template');
  }
  const payload: ReviewRunPayload = ReviewRunPayloadSchema.parse({
    connectionId,
    reviewOf: resolved.reviewOf,
    sourceRunId: source.id,
    ...(preset
      ? {
          onBlocking: preset.onBlocking,
          presetId: preset.id,
          ...(preset.systemPrompt ? { systemPrompt: preset.systemPrompt } : {}),
        }
      : {}),
  });
  const workflowId = reviewWorkflowId(
    connectionId,
    input.nonceHex ?? randomBytes(4).toString('hex')
  );
  const runId = reviewRunId(workflowId);
  const workRequestId = reviewRunId(workflowId, 'input');
  const externalTicketId = `review-${workflowId.slice(-8)}`;
  const description = `Review of run ${source.id}`;
  const requestPayload = JSON.stringify({
    sourceRunId: source.id,
    ...(preset ? { presetId: preset.id } : { templateId: template.id }),
  });
  const request: RepoWorkRequest = {
    connectionId,
    description,
    externalTicketId,
    ...(input.launchedById ? { launchedById: input.launchedById } : {}),
    payload,
    repoId: connectionId,
    requestPayload,
    workRequestId,
    workspaceProvider: 'git_repo',
  };
  const runInput: Prisma.RunInputUncheckedCreateInput = {
    connectionId,
    description,
    externalTicketId,
    id: workRequestId,
    knowledgeSourceKind: 'REPOSITORY',
    knowledgeSourceOrgId: repo.team.orgId,
    knowledgeSourceRepoId: repo.id,
    knowledgeSourceTeamId: repo.teamId,
    payload: payload as unknown as Prisma.InputJsonObject,
    requestedById: input.launchedById ?? null,
    requestPayload,
    templateId: template.id,
    templateVersion: template.activeVersion,
    ticketIsSynthetic: true,
  };
  const activeWorkflow: Prisma.ActiveWorkflowUncheckedCreateInput & { temporalWorkflowId: string } =
    {
      currentStatus: 'VALIDATING',
      repoId: connectionId,
      temporalWorkflowId: workflowId,
      workRequestId,
    };
  return {
    activeWorkflow,
    payload,
    repo,
    request,
    runId,
    runInput,
    source,
    template,
    templateVersion: template.activeVersion,
    workflowId,
  };
}

export type PreparedReviewLaunch = Awaited<ReturnType<typeof prepareReviewLaunch>>;

export async function recordReviewLaunch(db: PrismaClient, prepared: PreparedReviewLaunch) {
  return db.$transaction(async (tx) => {
    const existing = await tx.activeWorkflow.findUnique({
      include: { workRequest: true },
      where: { temporalWorkflowId: prepared.workflowId },
    });
    if (existing) {
      const saved = existing.workRequest;
      if (
        !saved?.templateId ||
        !saved.templateVersion ||
        saved.id !== prepared.request.workRequestId
      ) {
        throw new ReviewLaunchError('REVIEW_CONFLICT', 'Another launch owns this review identity');
      }
      return {
        request: { ...prepared.request, payload: ReviewRunPayloadSchema.parse(saved.payload) },
        templateId: saved.templateId,
        templateVersion: saved.templateVersion,
      };
    }
    await tx.runInput.create({ data: prepared.runInput });
    await tx.activeWorkflow.create({ data: prepared.activeWorkflow });
    return {
      request: prepared.request,
      templateId: prepared.template.id,
      templateVersion: prepared.templateVersion,
    };
  });
}

export async function reviewRunMetadata(db: PrismaClient, runId: string) {
  const { facts } = await loadReviewSource(db, runId);
  const resolved = resolveReviewOf(facts);
  const source = await db.workflowRun.findUnique({
    select: { reviewOfRun: { select: { id: true, template: { select: { name: true } } } } },
    where: { id: runId },
  });
  const reviews = await db.workflowRun.findMany({
    include: {
      reviewPreset: { select: { name: true } },
      steps: {
        orderBy: [{ startedAt: 'desc' }, { attempt: 'desc' }],
        take: 1,
        where: { status: 'PASSED', stepName: 'publishReviewResult' },
      },
      template: { select: { name: true } },
    },
    orderBy: { startedAt: 'desc' },
    where: { reviewOfRunId: runId },
  });
  return {
    reviewable: resolved.ok,
    ...(!resolved.ok ? { reason: resolved.code } : {}),
    ...(source?.reviewOfRun
      ? {
          reviewOf: {
            runId: source.reviewOfRun.id,
            templateName: source.reviewOfRun.template.name,
          },
        }
      : {}),
    reviews: reviews.map((review) => {
      const summary = object(review.steps[0]?.outputs);
      return {
        approved: typeof summary.approved === 'boolean' ? summary.approved : null,
        presetName: review.reviewPreset?.name ?? null,
        runId: review.id,
        startedAt: review.startedAt.toISOString(),
        status: review.status,
        templateName: review.template.name,
        workflowId: review.workflowId,
        worstSeverity: ['PASS', 'INFO', 'WARNING', 'CRITICAL'].includes(
          String(summary.worstSeverity)
        )
          ? String(summary.worstSeverity)
          : null,
      };
    }),
  };
}
