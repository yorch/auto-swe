import crypto from 'node:crypto';
import { generateBranchName, generateWorkflowId } from '@auto-swe/shared/lib/workflowId';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

const CreateWorkRequestSchema = z.object({
  budgetTier: z.enum(['STANDARD', 'LARGE', 'EPIC']).optional().default('STANDARD'),
  description: z.string().min(1, 'description is required — tell the agent what to implement'),
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: CreateWorkRequestSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds, budgetTier } = request.body;
      const user = requireUser(request);

      // Verify repository exists and is accessible to the requesting user.
      // Include team membership so non-admins can only trigger work on their
      // own team's repos without a second round-trip query.
      const repo = await fastify.prisma.repository.findUnique({
        include: {
          team: {
            select: {
              memberships: {
                select: { userId: true },
                where: { userId: user.sub },
              },
            },
          },
        },
        where: { id: repoIds[0] },
      });
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${repoIds[0]} not found or inactive`,
          },
        });
      }

      if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
        });
      }

      // Generate deterministic workflow ID (includes org to prevent cross-org collisions)
      const temporalWorkflowId = generateWorkflowId(
        externalTicketId,
        repo.organizationName,
        repo.repoName
      );
      const branch = generateBranchName(externalTicketId);

      // Generate the work request ID upfront so it can be passed to Temporal
      // before the DB row exists. This avoids the ordering problem where
      // the workflow needs the ID but the DB write happens after workflow start.
      const workRequestId = crypto.randomUUID();

      // Start Temporal workflow FIRST — this is the idempotency gate.
      // If the workflow already exists, Temporal returns WorkflowExecutionAlreadyStartedError
      // and we haven't written any orphan DB rows yet.
      try {
        await fastify.temporal.startWorkflow(temporalWorkflowId, {
          budgetTier,
          description,
          externalTicketId,
          repoId: repo.id,
          requestPayload: JSON.stringify(request.body),
          workRequestId,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'WORKFLOW_ALREADY_EXISTS',
              message: `Workflow already running for ${externalTicketId}`,
            },
          });
        }
        throw err;
      }

      // Workflow started — now persist to DB.
      // If DB write fails, the Temporal workflow will eventually time out,
      // which is preferable to orphan DB rows that block future retries.
      const workRequest = await fastify.prisma.workRequest.create({
        data: {
          description,
          externalTicketId,
          id: workRequestId,
          requestPayload: JSON.stringify(request.body),
        },
      });

      const activeWorkflow = await fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: branch,
          budgetTier,
          currentStatus: 'IMPLEMENTING',
          repoId: repo.id,
          temporalWorkflowId,
          workRequestId: workRequest.id,
        },
      });

      return reply.status(201).send({
        data: {
          workflowIds: [activeWorkflow.id],
          workRequestId: workRequest.id,
        },
      });
    }
  );
};
