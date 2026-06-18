import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

const CreatePrdRunSchema = z.object({
  /** Full content of the PRD document (copied from Confluence / Google Docs). */
  prdContent: z.string().min(1, 'prdContent is required'),
  /** Title of the PRD. */
  prdTitle: z.string().min(1, 'prdTitle is required'),
  /**
   * Jira project key, Linear team id, or GitHub "owner/repo" string used when
   * creating tracker items. Optional — omit if the tracker is not configured.
   */
  projectKey: z.string().optional(),
  /**
   * IDs of the git_repo Connections that the PRD spans. Used by
   * `submitPrdWorkRequests` to route stories to the correct repository.
   */
  repoIds: z.array(z.string().uuid()).min(1, 'at least one repoId is required'),
});

const PRD_WORKFLOW_ID_PREFIX = 'prd-';

export const prdRunRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /api/v1/prd-runs
   *
   * Starts a PRD decomposition workflow: the agent analyses the PRD, a PM
   * reviews the analysis, the agent decomposes it into epics + stories, an
   * engineer approves the breakdown, and the system creates tracker tickets and
   * submits each story as an implementation work request.
   */
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreatePrdRunSchema },
    },
    async (request, reply) => {
      const { prdTitle, prdContent, repoIds, projectKey } = request.body;
      const user = requireUser(request);

      // Validate all repos exist, are active git_repo connections, and the user
      // has access (mirrors the epic-submission route).
      const repos = await fastify.prisma.connection.findMany({
        select: {
          id: true,
          organizationName: true,
          repoName: true,
          team: {
            select: {
              memberships: {
                select: { userId: true },
                where: { userId: user.sub },
              },
            },
          },
        },
        where: { id: { in: repoIds }, isActive: true, type: 'git_repo' },
      });

      const foundIds = new Set(repos.map((r) => r.id));
      const missingIds = repoIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return reply.status(404).send({
          error: {
            code: 'REPOS_NOT_FOUND',
            message: `Repositories not found or inactive: ${missingIds.join(', ')}`,
          },
        });
      }

      if (user.role !== 'ADMIN') {
        const inaccessible = repos.filter((r) => r.team.memberships.length === 0);
        if (inaccessible.length > 0) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `You do not have access to: ${inaccessible
                .map((r) => `${r.organizationName}/${r.repoName}`)
                .join(', ')}`,
            },
          });
        }
      }

      // Find the prd-decomposition workflow template.
      const template = await fastify.prisma.workflowTemplate.findFirst({
        orderBy: { activeVersion: 'desc' },
        select: { activeVersion: true, id: true },
        where: { name: 'prd-decomposition', status: 'ACTIVE' },
      });
      if (!template?.activeVersion) {
        return reply.status(503).send({
          error: {
            code: 'TEMPLATE_NOT_FOUND',
            message:
              'prd-decomposition workflow template not found. Run `yarn db:seed` to seed built-in templates.',
          },
        });
      }

      const workRequestId = crypto.randomUUID();
      const prdWorkflowId = `${PRD_WORKFLOW_ID_PREFIX}${prdTitle
        .slice(0, 40)
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase()}-${workRequestId.slice(0, 8)}`;
      const requestPayload = JSON.stringify({
        prdContent,
        prdTitle,
        ...(projectKey ? { projectKey } : {}),
        repoIds,
      });

      // Use the first repo as the RepoWorkRequest.repoId placeholder (the PRD
      // activities look up the full repoIds from RunInput.requestPayload).
      // Safety: repoIds is validated min(1) by the Zod schema above.
      const primaryRepoId = repoIds[0] as string;

      const workflowInput = {
        request: {
          description: prdTitle,
          externalTicketId: `PRD-${workRequestId.slice(0, 8).toUpperCase()}`,
          repoId: primaryRepoId,
          requestPayload,
          workRequestId,
        },
        templateId: template.id,
        templateVersion: template.activeVersion,
      };

      // Start Temporal workflow first (idempotency gate).
      try {
        await fastify.temporal.startRunnableWorkflow(prdWorkflowId, workflowInput);
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'PRD_RUN_ALREADY_EXISTS',
              message: `A PRD run workflow is already running for this ID: ${prdWorkflowId}`,
            },
          });
        }
        throw err;
      }

      // Persist the RunInput row.
      await fastify.prisma.runInput.create({
        data: {
          description: prdTitle,
          externalTicketId: workflowInput.request.externalTicketId,
          id: workRequestId,
          isCrossRepo: true,
          requestedById: user.sub,
          requestPayload,
          templateId: template.id,
          templateVersion: template.activeVersion,
        },
      });

      return reply.status(201).send({
        data: {
          prdWorkflowId,
          workRequestId,
        },
      });
    }
  );
};
