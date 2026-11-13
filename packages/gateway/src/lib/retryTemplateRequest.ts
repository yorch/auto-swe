import crypto from 'node:crypto';
import type { Prisma } from '@auto-swe/shared';
import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  type WorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { BudgetTier, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from '../plugins/auth.js';
import { egressPolicyForRerun, storedEgressPolicy } from './egressPolicyLaunch.js';
import { storedKnowledgeBases, validateKnowledgeBaseOverrides } from './knowledgeBases.js';
import { authorizeLaunch, sendLaunchRefusal } from './launchAuthorization.js';
import { launchBaseBranch } from './launchBaseBranch.js';
import { validateRunConnection } from './runConnection.js';
import { latestRunIdForWorkRequest, runProvenance } from './runProvenance.js';
import { buildWorkflowRunVisibilityFilter } from './runVisibility.js';
import { isSystemTemplate } from './systemTemplate.js';
import {
  inputsSatisfySchema,
  launchableTemplateWhere,
  sendTemplateNotLaunchable,
} from './templateLaunch.js';
import { refuseUnchangedRerun } from './unchangedRerun.js';
import { launchTrackedWorkflow } from './workflowLaunch.js';

/** Re-run a connection-free or non-git workflow with its recorded input/version. */
export async function retryTemplateRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: Prisma.RunInputGetPayload<object>,
  instructions?: string,
  acknowledgeUnchanged?: boolean
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
      inputSchema: true,
      origin: true,
      team: {
        select: {
          id: true,
          memberships: { select: { userId: true }, where: { userId: user.sub } },
          monthlyBudgetUsdCents: true,
          name: true,
          organization: { select: { id: true, monthlyBudgetUsdCents: true } },
        },
      },
      teamId: true,
      workspaceProvider: true,
    },
    where: launchableTemplateWhere(user, input.templateId),
  });
  if (!template) {
    return sendTemplateNotLaunchable(reply);
  }
  if (isSystemTemplate(template)) {
    return reply.status(409).send({
      error: {
        code: 'NO_TEMPLATE_SNAPSHOT',
        message: 'This request cannot be retried through this endpoint',
      },
    });
  }
  // The version this retry runs. Its schema, not the template's current one, is what the run's
  // authorized set is computed from — and what the recorded payload was written against — so both
  // decisions below read it. A version that declares no schema declares no connection either.
  const version = await app.prisma.workflowTemplateVersion.findFirst({
    select: { inputSchema: true },
    where: { templateId: input.templateId, version: input.templateVersion },
  });
  const versionSchema = isInputSchema(version?.inputSchema) ? version.inputSchema : null;
  const providerMeta =
    template.workspaceProvider && isWorkspaceProviderType(template.workspaceProvider)
      ? getWorkspaceProviderMetadata(template.workspaceProvider)
      : null;
  const connection = await validateRunConnection(
    {
      connectionId: input.connectionId,
      gate: request.repoAccessGate,
      inputSchema: versionSchema,
      log: request.log,
      // A retry re-uses the recorded payload, so its declared connections are
      // authorized again rather than trusted because the first launch passed.
      payload: input.payload,
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
  // A connection-less retry reuses the request, so it is billed to the org its first launch
  // charged the request to (`billingOrgId`) — and gated against that same org, not whatever
  // the template's team is now, so the decision and the bill name one organization. A request
  // charged to no org (its connection was deleted, its org was deleted, or its template had no
  // team at launch) is gated against the template team's org, as a fresh launch would be, and
  // that org is recorded on the request with the retry's ledger row (`stampOrg` below) so the
  // retry is billed where it was gated.
  const stampedOrg =
    !input.connectionId && input.billingOrgId
      ? await app.prisma.organization.findUnique({
          select: { id: true, monthlyBudgetUsdCents: true },
          where: { id: input.billingOrgId },
        })
      : null;
  const billingOrg = input.connectionId
    ? null
    : (stampedOrg ?? template.team?.organization ?? null);
  const stampOrg = billingOrg && billingOrg.id !== input.billingOrgId ? billingOrg.id : null;
  // The team the retry is held to is the one `resolveWorkflowRunAttribution` will attribute it to
  // for a request with no connection: a service principal's team (a machine's request), else the
  // template's team, else the team the request was first charged to (`billingTeamId`). A retry
  // stamps it when the request carries none, as the org is, so it is counted where it was gated.
  const teamSelect = {
    id: true,
    memberships: { select: { userId: true }, where: { userId: user.sub } },
    monthlyBudgetUsdCents: true,
    name: true,
  } as const;
  const servicePrincipalTeam =
    !input.connectionId && input.requestedByServiceId
      ? ((
          await app.prisma.servicePrincipal.findUnique({
            select: { team: { select: teamSelect } },
            where: { id: input.requestedByServiceId },
          })
        )?.team ?? null)
      : null;
  const stampedTeam =
    !input.connectionId && input.billingTeamId
      ? await app.prisma.team.findUnique({
          select: teamSelect,
          where: { id: input.billingTeamId },
        })
      : null;
  const billingTeam = input.connectionId
    ? null
    : (servicePrincipalTeam ?? template.team ?? stampedTeam);
  const stampTeam = billingTeam && billingTeam.id !== input.billingTeamId ? billingTeam.id : null;
  if (billingOrg || billingTeam) {
    const authorization = await authorizeLaunch(app.prisma, user, {
      gate: request.repoAccessGate,
      log: request.log,
      orgs: billingOrg ? [billingOrg] : [],
      repos: [],
      // A connection-less run spends the team it is attributed to (see above).
      teams: billingTeam
        ? [
            {
              id: billingTeam.id,
              isMember: billingTeam.memberships.length > 0,
              monthlyBudgetUsdCents: billingTeam.monthlyBudgetUsdCents,
              name: billingTeam.name,
            },
          ]
        : [],
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
  if (!inputsSatisfySchema(reply, versionSchema, payload)) {
    return;
  }
  // Instructions change the request, so only a retry without them can be unchanged.
  if (
    await refuseUnchangedRerun(
      { gate: request.repoAccessGate, log: request.log, prisma: app.prisma, user },
      {
        description: input.description,
        payload: stored,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
      },
      reply,
      acknowledgeUnchanged || !!instructions
    )
  ) {
    return;
  }
  // The original's base, re-checked: the branch prefix may have changed since.
  const base = await launchBaseBranch(payload, reply);
  if (!base.ok) {
    return;
  }
  const budgetTier: BudgetTier =
    stored.budget === 'LARGE' || stored.budget === 'EPIC' ? stored.budget : 'STANDARD';
  const temporalWorkflowId = `wf-${template.id.replace(/-/g, '').slice(0, 8)}-${crypto.randomUUID().replace(/-/g, '')}`;
  const retryEgress = await egressPolicyForRerun(storedEgressPolicy(input.requestPayload), {
    orgId: connection.source?.orgId,
    teamId: connection.source?.teamId,
    workflowTemplateId: template.id,
  });
  const kbSource =
    connection.source ??
    (template.teamId && template.team?.organization?.id
      ? { orgId: template.team.organization.id, teamId: template.teamId }
      : undefined);
  const knowledgeBaseOverrides = await validateKnowledgeBaseOverrides(
    app.prisma,
    reply,
    kbSource ? { ...kbSource, templateId: template.id } : undefined,
    storedKnowledgeBases(input.requestPayload)
  );
  if (knowledgeBaseOverrides === false) {
    return;
  }
  const runRequest: RepoWorkRequest = {
    ...(knowledgeBaseOverrides ? { knowledgeBaseOverrides } : {}),
    budgetTier,
    connectionId: input.connectionId,
    description,
    // The launcher's stored egress choice, held at least as strict as the cascade the worker
    // pins at: a connection's team and org, none for a connection-less run.
    ...(retryEgress ? { egressPolicy: retryEgress } : {}),
    externalTicketId: input.externalTicketId,
    launchedById: user.sub,
    payload,
    repoId: input.connectionId,
    requestPayload: input.requestPayload,
    workRequestId: input.id,
    workspaceProvider: template.workspaceProvider as WorkspaceProviderType | null,
    ...runProvenance({
      actor: user,
      rerunOfRunId: await latestRunIdForWorkRequest(app.prisma, input.id, app.log),
      trigger: 'template-retry',
    }),
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
    {
      // In the ledger transaction, so the request is charged to the gated org and team exactly
      // when the retry's row is written. Only a request still charged as it was read is changed:
      // a concurrent retry that stamped first is left alone.
      ...(stampOrg || stampTeam
        ? {
            guard: async (tx: Prisma.TransactionClient) => {
              await tx.runInput.updateMany({
                data: {
                  ...(stampOrg ? { billingOrgId: stampOrg } : {}),
                  ...(stampTeam ? { billingTeamId: stampTeam } : {}),
                },
                where: {
                  billingOrgId: input.billingOrgId ?? null,
                  billingTeamId: input.billingTeamId ?? null,
                  connectionId: null,
                  id: input.id,
                },
              });
              return null;
            },
          }
        : {}),
      audit: {
        actor: user,
        ...(retryEgress ? { egressPolicy: retryEgress } : {}),
        source: 'template-retry',
        templateId: input.templateId as string,
      },
      log: app.log,
    }
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
