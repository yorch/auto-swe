import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  type WorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { BudgetTier, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '../plugins/auth.js';
import { authorizeLaunch, sendLaunchRefusal } from './launchAuthorization.js';
import { validateRunConnection } from './runConnection.js';
import { buildWorkflowRunVisibilityFilter } from './runVisibility.js';
import { isSystemTemplate } from './systemTemplate.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/** Re-run a connection-free or non-git workflow with its recorded input/version. */
export async function retryTemplateRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: Prisma.RunInputGetPayload<object>,
  instructions?: string
) {
  const user = requireUser(request);
  const previous = await app.prisma.workflowRun.findFirst({
    select: { id: true },
    where: {
      AND: [
        buildWorkflowRunVisibilityFilter(user, request.repoAccessGate),
        { workRequestId: input.id },
      ],
    },
  });
  if (
    !previous ||
    input.isCrossRepo ||
    !input.templateId ||
    !input.templateVersion ||
    input.payload == null
  ) {
    return reply.status(404).send({
      error: { code: 'WORK_REQUEST_NOT_FOUND', message: 'No retryable work request found' },
    });
  }
  const template = await app.prisma.workflowTemplate.findFirst({
    select: {
      id: true,
      origin: true,
      team: { select: { organization: { select: { id: true, monthlyBudgetUsdCents: true } } } },
      teamId: true,
      workspaceProvider: true,
    },
    where: { id: input.templateId },
  });
  if (!template || isSystemTemplate(template)) {
    return reply.status(409).send({
      error: {
        code: 'NO_TEMPLATE_SNAPSHOT',
        message: 'This request cannot be retried through this endpoint',
      },
    });
  }
  const providerMeta =
    template.workspaceProvider && isWorkspaceProviderType(template.workspaceProvider)
      ? getWorkspaceProviderMetadata(template.workspaceProvider)
      : null;
  const connection = await validateRunConnection(
    {
      connectionId: input.connectionId,
      gate: request.repoAccessGate,
      log: request.log,
      prisma: app.prisma,
      providerMeta,
      templateTeamId: template.teamId,
      user,
    },
    reply
  );
  if (!connection.ok) {
    return;
  }
  if (!connection.budgetOrgId && template.team?.organization) {
    const authorization = await authorizeLaunch(app.prisma, user, {
      gate: request.repoAccessGate,
      log: request.log,
      orgs: [template.team.organization],
      repos: [],
    });
    if (!authorization.ok) {
      return sendLaunchRefusal(reply, authorization.refusal);
    }
  }
  const description = instructions
    ? `${input.description}\n\nAdditional instructions for this attempt:\n${instructions}`
    : input.description;
  const stored =
    typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const payload = {
    ...stored,
    ...(instructions && typeof stored.description === 'string' ? { description } : {}),
  };
  const budgetTier: BudgetTier =
    stored.budget === 'LARGE' || stored.budget === 'EPIC' ? stored.budget : 'STANDARD';
  const temporalWorkflowId = `wf-${template.id.replace(/-/g, '').slice(0, 8)}-${crypto.randomUUID().replace(/-/g, '')}`;
  const runRequest: RepoWorkRequest = {
    budgetTier,
    connectionId: input.connectionId,
    description,
    externalTicketId: input.externalTicketId,
    launchedById: user.sub,
    payload,
    repoId: input.connectionId,
    requestPayload: input.requestPayload,
    workRequestId: input.id,
    workspaceProvider: template.workspaceProvider as WorkspaceProviderType | null,
  };
  const launched = await launchTrackedWorkflow(
    app.prisma,
    {
      activeWorkflow: {
        budgetTier,
        currentStatus: 'IMPLEMENTING',
        repoId: input.connectionId,
        temporalWorkflowId,
        workRequestId: input.id,
      },
    },
    () =>
      app.temporal.startRunnableWorkflow(temporalWorkflowId, {
        request: runRequest,
        templateId: input.templateId as string,
        templateVersion: input.templateVersion as number,
      }),
    { log: app.log }
  );
  if (!launched.ok) {
    return reply
      .status(409)
      .send({ error: { code: 'RUN_CONFLICT', message: 'This attempt could not be started' } });
  }
  return reply.status(201).send({
    data: {
      epicWorkflowId: null,
      temporalWorkflowId,
      workflowIds: [launched.activeWorkflowId],
      workRequestId: input.id,
    },
  });
}
