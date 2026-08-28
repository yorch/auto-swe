/**
 * Org-level budget management (P5 billing).
 * Mounted at /api/v1/admin/organizations.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentYearMonth } from '../lib/orgAccess.js';
import { requireAuth } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });

const PatchBudgetSchema = z.object({
  /** Alert threshold as a percentage of the monthly cap (0-100). Null disables the alert. */
  budgetAlertThresholdPercent: z.number().int().min(0).max(100).nullable(),
  /** Monthly cap in USD cents. Null removes the cap entirely. */
  monthlyBudgetUsdCents: z.number().int().min(0).nullable(),
});

const orgBudgetPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/admin/organizations/:orgId/budget — any org member may read.
  f.get(
    '/:orgId/budget',
    { onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }) },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);

      const [org, usage] = await Promise.all([
        fastify.prisma.organization.findUnique({
          select: {
            budgetAlertThresholdPercent: true,
            id: true,
            monthlyBudgetUsdCents: true,
            name: true,
          },
          where: { id: orgId },
        }),
        fastify.prisma.orgMonthlyUsage.findUnique({
          where: { orgId_yearMonth: { orgId, yearMonth: currentYearMonth() } },
        }),
      ]);
      if (!org) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      return {
        budgetAlertThresholdPercent: org.budgetAlertThresholdPercent,
        currentMonthUsage: usage
          ? {
              costUsdAccrued: Number(usage.costUsdAccrued),
              runsCompleted: usage.runsCompleted,
              tokensInput: Number(usage.tokensInput),
              tokensOutput: Number(usage.tokensOutput),
              yearMonth: usage.yearMonth,
            }
          : null,
        monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
        orgId: org.id,
        orgName: org.name,
      };
    }
  );

  // PATCH /api/v1/admin/organizations/:orgId/budget — ORG_ADMIN only.
  f.patch(
    '/:orgId/budget',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: PatchBudgetSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const { budgetAlertThresholdPercent, monthlyBudgetUsdCents } = PatchBudgetSchema.parse(
        request.body
      );

      const org = await fastify.prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      const updated = await fastify.prisma.organization.update({
        data: { budgetAlertThresholdPercent, monthlyBudgetUsdCents },
        select: {
          budgetAlertThresholdPercent: true,
          id: true,
          monthlyBudgetUsdCents: true,
          name: true,
        },
        where: { id: orgId },
      });
      return updated;
    }
  );
};

export const orgBudgetRoutes = fp(orgBudgetPlugin, {
  fastify: '5.x',
  name: 'org-budget-routes',
});
