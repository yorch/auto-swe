import crypto from 'node:crypto';
import { resolveSettings } from '@auto-swe/shared/config';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import {
  installationRetiredErrorBody,
  isInstallationRetired,
} from '@auto-swe/shared/lib/repoAccessDecision';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '../plugins/auth.js';
import { writeAuditLog } from './auditLog.js';
import { workflowIdFromIdempotencyKey } from './idempotency.js';
import { authorizeLaunch } from './launchAuthorization.js';
import { canManageTeamRepos } from './repoPermissions.js';
import { findLaunchConnection } from './runConnection.js';
import { isShellAuthor } from './specCheck.js';
import { launchTrackedTemplateRun } from './trackedTemplateLaunch.js';

export class OnboardingLaunchError extends Error {
  constructor(
    public statusCode: number,
    public body: unknown
  ) {
    super('Repository onboarding launch refused');
  }
}

function refuse(statusCode: number, code: string, message: string): never {
  throw new OnboardingLaunchError(statusCode, { error: { code, message } });
}

export async function launchRepoOnboarding(
  fastify: FastifyInstance,
  request: FastifyRequest,
  connectionId: string,
  idempotencyKey?: string
) {
  const user = requireUser(request);
  if (user.role !== 'LEAD' && user.role !== 'ADMIN') {
    refuse(403, 'REPO_SETUP_FORBIDDEN', 'Requires LEAD role');
  }
  const repo = await findLaunchConnection(fastify.prisma, connectionId, user);
  if (!repo?.isActive) {
    refuse(404, 'REPO_NOT_FOUND', 'Repository not found or inactive');
  }
  if (
    !(await canManageTeamRepos(fastify.prisma, user, repo.teamId)) ||
    !(await isShellAuthor(fastify, user, repo.teamId))
  ) {
    refuse(
      403,
      'REPO_SETUP_FORBIDDEN',
      'Requires repository lead and shell-author/team-admin access'
    );
  }
  if (repo.type !== 'git_repo') {
    refuse(400, 'NOT_A_GIT_REPO', 'Only git repositories support onboarding');
  }
  if (isInstallationRetired(repo)) {
    throw new OnboardingLaunchError(409, installationRetiredErrorBody());
  }
  const tpl = await fastify.prisma.workflowTemplate.findFirst({
    select: { activeVersion: true, id: true, inputSchema: true },
    where: { name: 'repo-onboarding', origin: 'swe-starter', status: 'ACTIVE', teamId: null },
  });
  if (!tpl?.activeVersion) {
    refuse(404, 'TEMPLATE_NOT_FOUND', 'Repository onboarding template is unavailable');
  }
  const payload = { connectionId };
  if (isInputSchema(tpl.inputSchema) && !validateInputPayload(tpl.inputSchema, payload).ok) {
    refuse(
      400,
      'INVALID_INPUT',
      'The onboarding template does not accept repository onboarding inputs'
    );
  }
  const authorization = await authorizeLaunch(fastify.prisma, user, {
    gate: request.repoAccessGate,
    log: request.log,
    repos: [repo],
  });
  if (!authorization.ok) {
    throw new OnboardingLaunchError(authorization.refusal.status, authorization.refusal.body);
  }
  const temporalWorkflowId = idempotencyKey
    ? workflowIdFromIdempotencyKey('onboard', `${connectionId}-${user.sub}`, idempotencyKey)
    : `onboard-${connectionId}-${crypto.randomUUID()}`;
  const runId = async () =>
    (
      await fastify.prisma.workflowRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { id: true },
        where: { workflowId: temporalWorkflowId },
      })
    )?.id ?? null;
  const previous = async () => {
    const row = await fastify.prisma.activeWorkflow.findUnique({
      select: { id: true, workRequestId: true },
      where: { temporalWorkflowId },
    });
    return row
      ? {
          deduplicated: true,
          runId: await runId(),
          temporalWorkflowId,
          workflowId: row.id,
          workRequestId: row.workRequestId,
        }
      : null;
  };
  if (idempotencyKey) {
    const existing = await previous();
    if (existing) {
      return existing;
    }
  }
  const workRequestId = crypto.randomUUID();
  const launch = await launchTrackedTemplateRun(
    fastify,
    {
      request: {
        budgetTier: 'STANDARD',
        connectionId,
        description: 'Repository onboarding',
        externalTicketId: workRequestId,
        launchedById: user.sub,
        payload,
        repoId: connectionId,
        requestPayload: JSON.stringify({ payload }),
        workRequestId,
        workspaceProvider: 'git_repo',
      },
      source: {
        knowledgeSourceRepo: { orgId: repo.team.orgId, repoId: connectionId, teamId: repo.teamId },
      },
      templateId: tpl.id,
      templateVersion: tpl.activeVersion,
      temporalWorkflowId,
    },
    {
      audit: { actor: user, source: 'repo-onboarding' },
      log: fastify.log,
      sourceAuthorization: { actor: user },
    }
  );
  if (!launch.ok) {
    if (idempotencyKey) {
      const existing = await previous();
      if (existing) {
        return existing;
      }
    }
    refuse(409, 'RUN_CONFLICT', 'An onboarding run already exists');
  }
  return {
    deduplicated: false,
    runId: await runId(),
    temporalWorkflowId,
    workflowId: launch.activeWorkflowId,
    workRequestId,
  };
}

export async function autoRunRepoOnboarding(
  fastify: FastifyInstance,
  request: FastifyRequest,
  connectionId: string,
  teamId: string
) {
  try {
    const team = await fastify.prisma.team.findUnique({
      select: { orgId: true },
      where: { id: teamId },
    });
    const settings = await resolveSettings(['onboarding.autoRunOnConnect'], {
      orgId: team?.orgId,
      teamId,
    });
    if (!settings['onboarding.autoRunOnConnect']) {
      return;
    }
    await launchRepoOnboarding(fastify, request, connectionId, `repo-onboarding:${connectionId}`);
  } catch (error) {
    request.log.warn(
      { err: error, repoId: connectionId },
      'Automatic repository onboarding not started'
    );
    try {
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: requireUser(request),
        after: { onboardingAutoRun: 'failed' },
        entityId: connectionId,
        entityType: 'Connection',
      });
    } catch (auditError) {
      request.log.warn(
        { err: auditError, repoId: connectionId },
        'Could not audit automatic onboarding failure'
      );
    }
  }
}
