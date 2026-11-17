import { Prisma } from '@auto-swe/shared';
import type {
  CreateTeamBudgetRequestBody,
  TeamBudgetRequestSummary,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { teamBudgetAccess } from '../lib/teamBudgetAccess.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParamsSchema = z.object({ id: z.string().uuid() });

const CreateBodySchema: z.ZodType<CreateTeamBudgetRequestBody> = z.object({
  reason: z.string().trim().min(1).max(500),
});

const REQUEST_SELECT = {
  createdAt: true,
  id: true,
  reason: true,
  requestedBy: { select: { id: true, name: true } },
} as const;

function summary(row: {
  id: string;
  reason: string;
  requestedBy: { id: string; name: string | null };
  createdAt: Date;
}): TeamBudgetRequestSummary {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    reason: row.reason,
    requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
  };
}

/**
 * A team LEAD asking the people who may change the team's cap to raise it. The request carries a
 * reason and no amount, and no response here carries the cap or the spend (`docs/teams.md`, "The
 * budget meter"). Saving the cap resolves the pending request (`routes/teamBudget.ts`).
 */
export const teamBudgetRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/teams/:id/budget-requests — one pending request per team, enforced by a partial
  // unique index; the second one answers 409.
  app.post(
    '/:id/budget-requests',
    {
      onRequest: requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'id' }),
      schema: { body: CreateBodySchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      try {
        const created = await fastify.prisma.$transaction(async (tx) => {
          const row = await tx.teamBudgetRequest.create({
            data: {
              reason: request.body.reason,
              requestedById: user.sub,
              teamId: request.params.id,
            },
            select: REQUEST_SELECT,
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: { reasonLength: request.body.reason.length },
            client: tx,
            entityId: row.id,
            entityType: 'TeamBudgetRequest',
          });
          return row;
        });
        return reply.status(201).send({ data: summary(created) });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return sendError(
            reply,
            409,
            'REQUEST_PENDING',
            'This team already has a budget request waiting'
          );
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
          return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
        }
        throw e;
      }
    }
  );

  // GET /api/v1/teams/:id/budget-requests — the pending requests, oldest first, for whoever may
  // set the cap: a team ADMIN, an ORG_ADMIN of the team's organization, a platform ADMIN.
  app.get(
    '/:id/budget-requests',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: TeamParamsSchema } },
    async (request, reply) => {
      const access = await teamBudgetAccess(
        fastify.prisma,
        requireUser(request),
        request.params.id
      );
      if (!access) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires ADMIN role in this team's budget");
      }
      const rows = await fastify.prisma.teamBudgetRequest.findMany({
        orderBy: { createdAt: 'asc' },
        select: REQUEST_SELECT,
        where: { resolvedAt: null, teamId: access.team.id },
      });
      return { data: rows.map(summary) };
    }
  );
};
