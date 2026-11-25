import { Prisma } from '@auto-swe/shared';
import type {
  CreateTeamBudgetRequestBody,
  TeamBudgetRequestSummary,
} from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditContextOf } from '../lib/auditContext.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { can } from '../lib/authz.js';
import { sendError } from '../lib/httpErrors.js';
import { teamBudgetAccess } from '../lib/teamBudgetAccess.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParamsSchema = z.object({ id: z.string().uuid() });
const RequestParamsSchema = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });

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
      onRequest: requireAuth({ capability: 'team.budget-requests.create', team: { param: 'id' } }),
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
  // set the cap (`team.budget.manage`).
  app.get(
    '/:id/budget-requests',
    {
      onRequest: requireAuth({ handlerChecked: ['team.budget.manage', 'team.budget.read'] }),
      schema: { params: TeamParamsSchema },
    },
    async (request, reply) => {
      const access = await teamBudgetAccess(request, fastify.prisma, request.params.id);
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

  // GET /api/v1/teams/:id/budget-requests/mine — the team's pending request, or null, for whoever
  // may ask (`team.budget-requests.create`), so a lead sees the outcome of what they sent. It
  // carries a reason and no amount, like the create response.
  app.get(
    '/:id/budget-requests/mine',
    {
      onRequest: requireAuth({ capability: 'team.budget-requests.create', team: { param: 'id' } }),
      schema: { params: TeamParamsSchema },
    },
    async (request) => {
      const row = await fastify.prisma.teamBudgetRequest.findFirst({
        orderBy: { createdAt: 'asc' },
        select: REQUEST_SELECT,
        where: { resolvedAt: null, teamId: request.params.id },
      });
      return { data: row ? summary(row) : null };
    }
  );

  // POST /api/v1/teams/:id/budget-requests/:requestId/cancel — withdraw a pending request. The
  // requester (while they may still ask) or whoever may decide it (`team.budget.manage`).
  app.post(
    '/:id/budget-requests/:requestId/cancel',
    {
      onRequest: requireAuth({
        handlerChecked: ['team.budget.manage', 'team.budget.read', 'team.budget-requests.create'],
      }),
      schema: { params: RequestParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await teamBudgetAccess(request, fastify.prisma, request.params.id);
      if (!access) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      const asker = await can(request, 'team.budget-requests.create', { teamId: access.team.id });
      if (!access.canManage && !asker.allowed) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires permission to ask for budget');
      }
      const { requestId } = request.params;
      const cancelled = await fastify.prisma.$transaction(async (tx) => {
        const { count } = await tx.teamBudgetRequest.updateMany({
          data: { resolvedAt: new Date() },
          // Someone who may only ask withdraws their own request, not a colleague's.
          where: {
            id: requestId,
            resolvedAt: null,
            teamId: access.team.id,
            ...(access.canManage ? {} : { requestedById: user.sub }),
          },
        });
        if (count === 0) {
          return false;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { cancelled: true },
          before: { resolvedAt: null },
          client: tx,
          context: { ...auditContextOf(request), authority: access.authority },
          entityId: requestId,
          entityType: 'TeamBudgetRequest',
        });
        return true;
      });
      if (!cancelled) {
        return sendError(
          reply,
          404,
          'BUDGET_REQUEST_NOT_FOUND',
          'No pending budget request with that id'
        );
      }
      return { data: { id: requestId } };
    }
  );

  // POST /api/v1/teams/:id/budget-requests/:requestId/dismiss — close a pending request without
  // changing the cap, so the lead can ask again. Whoever may set the cap may dismiss.
  app.post(
    '/:id/budget-requests/:requestId/dismiss',
    {
      onRequest: requireAuth({ handlerChecked: ['team.budget.manage', 'team.budget.read'] }),
      schema: { params: RequestParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await teamBudgetAccess(request, fastify.prisma, request.params.id);
      if (!access) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found');
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires ADMIN role in this team's budget");
      }
      const { requestId } = request.params;
      const dismissed = await fastify.prisma.$transaction(async (tx) => {
        const { count } = await tx.teamBudgetRequest.updateMany({
          data: { resolvedAt: new Date() },
          where: { id: requestId, resolvedAt: null, teamId: access.team.id },
        });
        if (count === 0) {
          return false;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { dismissed: true },
          before: { resolvedAt: null },
          client: tx,
          context: { ...auditContextOf(request), authority: access.authority },
          entityId: requestId,
          entityType: 'TeamBudgetRequest',
        });
        return true;
      });
      if (!dismissed) {
        return sendError(
          reply,
          404,
          'BUDGET_REQUEST_NOT_FOUND',
          'No pending budget request with that id'
        );
      }
      return { data: { id: requestId } };
    }
  );
};
