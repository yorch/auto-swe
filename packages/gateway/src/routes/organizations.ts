import { Prisma } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentYearMonth } from '../lib/orgAccess.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });

const PatchOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case')
    .optional(),
});

function computeAlert(
  cap: number | null,
  threshold: number | null,
  spent: number
): { percent: number | null; triggered: boolean } {
  if (cap == null || cap <= 0 || threshold == null) {
    return { percent: null, triggered: false };
  }
  const percent = (spent / (cap / 100)) * 100;
  return { percent, triggered: percent >= threshold };
}

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List organizations the current user is a member of, with budget + alert state.
  app.get('/', { onRequest: requireAuth({ requiredRole: 'LEAD' }) }, async (request) => {
    const user = requireUser(request);
    const rows = await fastify.prisma.organizationMembership.findMany({
      include: {
        organization: {
          include: {
            monthlyUsages: { where: { yearMonth: currentYearMonth() } },
          },
        },
      },
      orderBy: { organization: { name: 'asc' } },
      where: { userId: user.sub },
    });
    return {
      data: rows.map((m) => {
        const org = m.organization;
        const usage = org.monthlyUsages[0];
        const spent = usage ? Number(usage.costUsdAccrued) : 0;
        const alert = computeAlert(
          org.monthlyBudgetUsdCents,
          org.budgetAlertThresholdPercent,
          spent
        );
        return {
          alert,
          budgetAlertThresholdPercent: org.budgetAlertThresholdPercent,
          currentMonthUsage: usage
            ? {
                costUsdAccrued: spent,
                runsCompleted: usage.runsCompleted,
                yearMonth: usage.yearMonth,
              }
            : null,
          id: org.id,
          monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
          name: org.name,
          role: m.role,
          slug: org.slug,
        };
      }),
    };
  });

  // GET /api/v1/admin/organizations/budget-alerts — platform ADMIN view of alerting orgs.
  app.get('/budget-alerts', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const orgs = await fastify.prisma.organization.findMany({
      include: {
        monthlyUsages: { where: { yearMonth: currentYearMonth() } },
      },
      orderBy: { name: 'asc' },
      where: { isActive: true },
    });
    return {
      data: orgs.map((org) => {
        const usage = org.monthlyUsages[0];
        const spent = usage ? Number(usage.costUsdAccrued) : 0;
        const alert = computeAlert(
          org.monthlyBudgetUsdCents,
          org.budgetAlertThresholdPercent,
          spent
        );
        return {
          alert,
          budgetAlertThresholdPercent: org.budgetAlertThresholdPercent,
          currentMonthUsage: usage
            ? {
                costUsdAccrued: spent,
                runsCompleted: usage.runsCompleted,
                yearMonth: usage.yearMonth,
              }
            : null,
          id: org.id,
          monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
          name: org.name,
          slug: org.slug,
        };
      }),
    };
  });

  // GET /api/v1/admin/organizations/:orgId — any org member may read.
  app.get(
    '/:orgId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }),
      schema: { params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const org = await fastify.prisma.organization.findUnique({
        select: {
          budgetAlertThresholdPercent: true,
          id: true,
          monthlyBudgetUsdCents: true,
          name: true,
          slug: true,
        },
        where: { id: orgId },
      });
      if (!org) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }
      return { data: org };
    }
  );

  // PATCH /api/v1/admin/organizations/:orgId — ORG_ADMIN can update name/slug.
  app.patch(
    '/:orgId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: { body: PatchOrgSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const body = PatchOrgSchema.parse(request.body);
      if (Object.keys(body).length === 0) {
        return reply.status(400).send({
          error: { code: 'INVALID_BODY', message: 'No fields to update' },
        });
      }

      const existing = await fastify.prisma.organization.findUnique({
        select: { id: true },
        where: { id: orgId },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      try {
        const updated = await fastify.prisma.organization.update({
          data: body,
          select: { id: true, name: true, slug: true },
          where: { id: orgId },
        });
        return { data: updated };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return reply.status(409).send({
            error: {
              code: 'ORG_EXISTS',
              message: 'Organization name or slug already in use',
            },
          });
        }
        throw e;
      }
    }
  );
};
