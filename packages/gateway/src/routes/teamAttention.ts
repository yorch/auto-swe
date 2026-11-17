import type { FailureAssignmentResult } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { loadUnownedFailures } from '../lib/teamAttention.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const LIST_LIMIT = 100;

const teamParams = z.object({ id: z.string().uuid() });

/** What a team lead has to act on: failures nobody owns any more, and who takes them over. */
export const teamAttentionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const lead = requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' });

  // GET /api/v1/teams/:id/attention/failures. The same definition the overview counts.
  app.get(
    '/:id/attention/failures',
    { onRequest: lead, schema: { params: teamParams } },
    async (request) => {
      const failures = await loadUnownedFailures(
        { gate: request.repoAccessGate, prisma: fastify.prisma, user: requireUser(request) },
        request.params.id,
        Date.now()
      );
      return { data: failures.slice(0, LIST_LIMIT) };
    }
  );

  // POST /api/v1/teams/:id/failure-assignments. Records who owns a failure; it never touches
  // `WorkflowRun.launchedById`, which is the key a per-user credential is resolved by.
  app.post(
    '/:id/failure-assignments',
    {
      onRequest: lead,
      schema: {
        body: z.object({ assigneeId: z.string().uuid(), runId: z.string().uuid() }),
        params: teamParams,
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const teamId = request.params.id;
      const { assigneeId, runId } = request.body;

      const membership = await fastify.prisma.teamMembership.findUnique({
        where: { userId_teamId: { teamId, userId: assigneeId } },
      });
      if (!membership) {
        return sendError(
          reply,
          422,
          'ASSIGNEE_NOT_MEMBER',
          'The assignee is not a member of this team'
        );
      }
      const notUnowned = () =>
        sendError(reply, 409, 'NOT_UNOWNED_FAILURE', 'This run is not an unowned failure');
      const unowned = await loadUnownedFailures(
        { gate: request.repoAccessGate, prisma: fastify.prisma, user },
        teamId,
        Date.now()
      );
      if (!unowned.some((failure) => failure.runId === runId)) {
        return notUnowned();
      }

      let assignedAt: Date;
      try {
        assignedAt = await fastify.prisma.$transaction(async (tx) => {
          const created = await tx.failureAssignment.create({
            data: { assignedById: user.sub, assigneeId, teamId, workflowRunId: runId },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: { assigneeId, runId, teamId },
            client: tx,
            entityId: created.id,
            entityType: 'FailureAssignment',
          });
          return created.createdAt;
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return notUnowned();
        }
        throw err;
      }
      const data: FailureAssignmentResult = {
        assignedAt: assignedAt.toISOString(),
        assigneeId,
        runId,
      };
      return reply.status(201).send({ data });
    }
  );
};
