import type { FailureAssignmentResult } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { loadUnownedFailureEntries, loadUnownedFailures } from '../lib/teamAttention.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const LIST_LIMIT = 100;

const teamParams = z.object({ id: z.string().uuid() });

/** What a team lead has to act on: failures nobody owns any more, and who takes them over. */
export const teamAttentionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const read = requireAuth({ capability: 'team.attention.read', team: { param: 'id' } });
  const manage = requireAuth({ capability: 'team.attention.manage', team: { param: 'id' } });

  // GET /api/v1/teams/:id/attention/failures. The same definition the overview counts.
  app.get(
    '/:id/attention/failures',
    { onRequest: read, schema: { params: teamParams } },
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
      onRequest: manage,
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
        select: { user: { select: { isActive: true } } },
        where: { userId_teamId: { teamId, userId: assigneeId } },
      });
      if (!membership?.user.isActive) {
        return sendError(
          reply,
          422,
          'ASSIGNEE_NOT_MEMBER',
          'The assignee is not an active member of this team'
        );
      }
      const notUnowned = () =>
        sendError(reply, 409, 'NOT_UNOWNED_FAILURE', 'This run is not an unowned failure');
      const unowned = await loadUnownedFailureEntries(
        { gate: request.repoAccessGate, prisma: fastify.prisma, user },
        teamId,
        Date.now()
      );
      const target = unowned.find((entry) => entry.failure.runId === runId);
      if (!target) {
        return notUnowned();
      }
      const stale = target.staleAssignment;

      let assignedAt: Date;
      try {
        assignedAt = await fastify.prisma.$transaction(async (tx) => {
          if (stale) {
            // The old assignee is gone: replace the lapsed assignment with this one.
            await tx.failureAssignment.deleteMany({
              where: { id: stale.id, teamId: stale.teamId },
            });
          }
          const created = await tx.failureAssignment.create({
            data: { assignedById: user.sub, assigneeId, teamId, workflowRunId: runId },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: { assigneeId, runId, teamId },
            ...(stale ? { before: { assigneeId: stale.assigneeId } } : {}),
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
