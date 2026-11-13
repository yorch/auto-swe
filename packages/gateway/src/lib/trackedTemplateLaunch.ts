import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { launchTrackedWorkflow, type WorkflowLedgerRows } from './workflowLaunch.js';

export function launchTrackedTemplateRun(
  fastify: FastifyInstance,
  input: {
    temporalWorkflowId: string;
    templateId: string;
    templateVersion: number;
    request: RepoWorkRequest;
    billingOrgId?: string | null;
    billingTeamId?: string | null;
    requestedByServiceId?: string | null;
    callback?: object | null;
    source?: Pick<WorkflowLedgerRows, 'knowledgeSourceRepo' | 'knowledgeSourceTeam'>;
  },
  options: Parameters<typeof launchTrackedWorkflow>[3]
) {
  const request = input.request;
  return launchTrackedWorkflow(
    fastify.prisma,
    {
      ...input.source,
      activeWorkflow: {
        budgetTier: request.budgetTier,
        currentStatus: 'IMPLEMENTING',
        repoId: request.connectionId ?? null,
        temporalWorkflowId: input.temporalWorkflowId,
        workRequestId: request.workRequestId,
      },
      runInput: {
        billingOrgId: input.billingOrgId ?? null,
        billingTeamId: input.billingTeamId ?? null,
        connectionId: request.connectionId,
        description: request.description,
        externalTicketId: request.externalTicketId,
        id: request.workRequestId,
        payload: request.payload as object,
        requestedById: request.launchedById ?? null,
        requestedByServiceId: input.requestedByServiceId ?? null,
        requestPayload: request.requestPayload,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        ticketIsSynthetic: request.externalTicketId === request.workRequestId,
        ...(input.callback ? { callback: { create: input.callback } } : {}),
      },
    },
    () =>
      fastify.temporal.startRunnableWorkflow(input.temporalWorkflowId, {
        request,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
      }),
    options
  );
}
