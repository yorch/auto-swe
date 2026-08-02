import crypto from 'node:crypto';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdempotencyHeaderSchema, workflowIdFromIdempotencyKey } from '../lib/idempotency.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

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
      schema: { body: CreatePrdRunSchema, headers: IdempotencyHeaderSchema },
    },
    async (request, reply) => {
      const { prdTitle, prdContent, repoIds, projectKey } = request.body;
      const user = requireUser(request);

      // Validate all repos exist, are active git_repo connections, and the user
      // has access (mirrors the epic-submission route).
      // Unscoped by design, same as the epic route: the memberships selected
      // here are the access decision, so filtering by team up front would turn
      // "you cannot see this repo" into "no such repo".
      const repos = await runUnscoped(
        'access is decided from the memberships selected here, not by the where clause',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
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
          })
      );

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
      // The title slug is for humans reading the Temporal UI; the suffix is what
      // makes the id unique. It used to be a slice of a fresh UUID, which meant
      // the PRD_RUN_ALREADY_EXISTS branch below could never actually fire —
      // every submission minted a new id, so a double-clicked PRD started two
      // decompositions. With an Idempotency-Key the suffix is a function of the
      // key, so the unique index on ActiveWorkflow.temporalWorkflowId becomes a
      // real gate; without one, behaviour is unchanged.
      const titleSlug = prdTitle
        .slice(0, 40)
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase();
      const idempotencyKey = request.headers['idempotency-key'];
      //
      // Scoped by the title slug rather than a constant, so reusing a key across
      // two genuinely different PRDs starts two runs instead of silently merging
      // them; a real retry carries the same title and collapses as intended.
      const prdWorkflowId = idempotencyKey
        ? workflowIdFromIdempotencyKey('prd', titleSlug, idempotencyKey)
        : `${PRD_WORKFLOW_ID_PREFIX}${titleSlug}-${workRequestId.slice(0, 8)}`;
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

      // Ledger row first, workflow second, rolled back if the start fails — see
      // `launchTrackedWorkflow`. A PRD run keeps no `ActiveWorkflow` ledger (its
      // spend is summed from `AgentTrace` at finalize, and the per-repo children
      // it submits carry their own rows), so there is no unique index to dedup
      // on — the DUPLICATE branch below fires on Temporal's own already-started
      // error, which a deterministic id above makes reachable.
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          runInput: {
            description: prdTitle,
            externalTicketId: workflowInput.request.externalTicketId,
            id: workRequestId,
            isCrossRepo: true,
            requestedById: user.sub,
            requestPayload,
            templateId: template.id,
            templateVersion: template.activeVersion,
          },
          temporalWorkflowId: prdWorkflowId,
        },
        () => fastify.temporal.startRunnableWorkflow(prdWorkflowId, workflowInput),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.status(409).send({
          error: {
            code: 'PRD_RUN_ALREADY_EXISTS',
            message: `A PRD run workflow is already running for this ID: ${prdWorkflowId}`,
          },
        });
      }

      return reply.status(201).send({
        data: {
          prdWorkflowId,
          workRequestId,
        },
      });
    }
  );
};
