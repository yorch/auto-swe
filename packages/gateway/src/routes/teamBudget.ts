import { teamMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import type { BudgetStatus, TeamBudgetSettings } from '@auto-swe/shared/types/api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { PG_INT_MAX } from '../lib/pgInt.js';
import { teamBudgetAccess } from '../lib/teamBudgetAccess.js';
import { bindingBudgetStatuses } from '../lib/teamBudgetStatus.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TeamParamsSchema = z.object({ id: z.string().uuid() });

/** `null` clears; an omitted key is left as it is. */
const UpdateTeamBudgetSchema = z.object({
  /** Alert threshold as a percentage of the team's cap, 1 to 100. */
  budgetAlertThresholdPercent: z.number().int().min(1).max(100).nullable().optional(),
  /** Monthly cap in USD cents. Zero is a cap that refuses every launch; null removes the cap. */
  monthlyBudgetUsdCents: z.number().int().min(0).max(PG_INT_MAX).nullable().optional(),
});

const NOT_FOUND = ['TEAM_NOT_FOUND', 'Team not found'] as const;

/**
 * A team's own monthly budget, beside its organization's (`docs/teams.md`, "Team budgets").
 *
 * The cap is a column on the team's own row, not a registry setting: it is read by the launch
 * gate and the mid-run guard, not resolved through the scope cascade.
 */
export const teamBudgetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  async function settingsFor(team: {
    id: string;
    monthlyBudgetUsdCents: number | null;
    budgetAlertThresholdPercent: number | null;
  }): Promise<TeamBudgetSettings> {
    const spend = await teamMonthSpend(fastify.prisma, team.id);
    return {
      budgetAlertThresholdPercent: team.budgetAlertThresholdPercent,
      monthlyBudgetUsdCents: team.monthlyBudgetUsdCents,
      monthSpendUsdCents: usdToCents(spend.totalUsd),
    };
  }

  // GET /api/v1/teams/:id/budget — the cap, threshold and month-to-date spend in dollars. Team
  // ADMIN, ORG_ADMIN of the team's organization, or platform ADMIN; anyone else with no standing
  // on the team gets the 404 an unknown team gets, and a member without the role gets a 403.
  app.get(
    '/:id/budget',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: TeamParamsSchema } },
    async (request, reply) => {
      const access = await teamBudgetAccess(
        fastify.prisma,
        requireUser(request),
        request.params.id
      );
      if (!access) {
        return sendError(reply, 404, ...NOT_FOUND);
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires ADMIN role in this team's budget");
      }
      return { data: await settingsFor(access.team) };
    }
  );

  // PATCH /api/v1/teams/:id/budget — set or clear the cap and the alert threshold.
  app.patch(
    '/:id/budget',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: UpdateTeamBudgetSchema, params: TeamParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const access = await teamBudgetAccess(fastify.prisma, user, request.params.id);
      if (!access) {
        return sendError(reply, 404, ...NOT_FOUND);
      }
      if (!access.canManage) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires ADMIN role in this team's budget");
      }
      const { budgetAlertThresholdPercent, monthlyBudgetUsdCents } = request.body;
      const data = {
        ...(budgetAlertThresholdPercent !== undefined ? { budgetAlertThresholdPercent } : {}),
        ...(monthlyBudgetUsdCents !== undefined ? { monthlyBudgetUsdCents } : {}),
      };
      const updated = await fastify.prisma.team.update({
        data,
        select: { budgetAlertThresholdPercent: true, id: true, monthlyBudgetUsdCents: true },
        where: { id: access.team.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: {
          budgetAlertThresholdPercent: updated.budgetAlertThresholdPercent,
          monthlyBudgetUsdCents: updated.monthlyBudgetUsdCents,
        },
        before: {
          budgetAlertThresholdPercent: access.team.budgetAlertThresholdPercent,
          monthlyBudgetUsdCents: access.team.monthlyBudgetUsdCents,
        },
        entityId: access.team.id,
        entityType: 'Team',
      });
      return { data: await settingsFor(updated) };
    }
  );

  // GET /api/v1/teams/:id/budget/status — the budget that binds the team's work, as a state and a
  // percentage and never an amount: the tighter of the team's own cap and its organization's, with
  // `scope` naming which. Any team member (and an ORG_ADMIN or platform ADMIN).
  app.get(
    '/:id/budget/status',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: TeamParamsSchema } },
    async (request, reply) => {
      const access = await teamBudgetAccess(
        fastify.prisma,
        requireUser(request),
        request.params.id
      );
      if (!access) {
        return sendError(reply, 404, ...NOT_FOUND);
      }
      const { id, orgId } = access.team;
      const status: BudgetStatus = (
        await bindingBudgetStatuses(fastify.prisma, [{ id, orgId }])
      ).get(id) ?? {
        alertThresholdPercent: null,
        percentUsed: null,
        scope: 'org',
        state: 'no_cap',
      };
      return { data: status };
    }
  );
};
