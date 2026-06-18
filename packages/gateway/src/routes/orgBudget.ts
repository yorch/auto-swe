/**
 * Org-level budget management (P5 billing).
 * Mounted at /api/v1/admin/organizations.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertOrgAccess, currentYearMonth } from '../lib/orgAccess.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });

const PatchBudgetSchema = z.object({
  /** Monthly cap in USD cents. Null removes the cap entirely. */
  monthlyBudgetUsdCents: z.number().int().min(0).nullable(),
});

const orgBudgetPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/admin/organizations/:orgId/budget
  f.get(
    '/:orgId/budget',
    { onRequest: requireAuth({ requiredRole: 'LEAD' }) },
    async (request, reply) => {
      const user = requireUser(request);
      const { orgId } = OrgParamsSchema.parse(request.params);
      const allowed = await assertOrgAccess(fastify.prisma, user, orgId, reply);
      if (!allowed) {
        return;
      }

      const [org, usage] = await Promise.all([
        fastify.prisma.organization.findUnique({
          select: { id: true, monthlyBudgetUsdCents: true, name: true },
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

  // PATCH /api/v1/admin/organizations/:orgId/budget
  f.patch(
    '/:orgId/budget',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: PatchBudgetSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const { monthlyBudgetUsdCents } = PatchBudgetSchema.parse(request.body);

      const org = await fastify.prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      const updated = await fastify.prisma.organization.update({
        data: { monthlyBudgetUsdCents },
        select: { id: true, monthlyBudgetUsdCents: true, name: true },
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
