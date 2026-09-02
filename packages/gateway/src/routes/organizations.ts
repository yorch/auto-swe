import { Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
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

interface OrgWithCurrentUsage {
  id: string;
  name: string;
  slug: string;
  monthlyBudgetUsdCents: number | null;
  budgetAlertThresholdPercent: number | null;
  monthlyUsages: Array<{ costUsdAccrued: unknown; runsCompleted: number; yearMonth: string }>;
}

/** Budget summary shared by the "my organizations" and budget-alert listings. */
function projectOrgBudgetSummary(org: OrgWithCurrentUsage) {
  const usage = org.monthlyUsages[0];
  const spent = usage ? Number(usage.costUsdAccrued) : 0;
  return {
    alert: computeAlert(org.monthlyBudgetUsdCents, org.budgetAlertThresholdPercent, spent),
    budgetAlertThresholdPercent: org.budgetAlertThresholdPercent,
    currentMonthUsage: usage
      ? { costUsdAccrued: spent, runsCompleted: usage.runsCompleted, yearMonth: usage.yearMonth }
      : null,
    id: org.id,
    monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
    name: org.name,
    slug: org.slug,
  };
}

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List organizations the current user is a member of, with budget + alert state.
  app.get('/', { onRequest: requireAuth({ requiredRole: 'LEAD' }) }, async (request) => {
    const user = requireUser(request);
    // Scoped by `userId` (the caller's own memberships), but the tenant guard
    // only recognises org/team keys as scoping — `userId` alone is a false
    // positive here. The query reads only the caller's own rows, so name the
    // model unscoped rather than weakening the guard to treat `userId` as a
    // tenant key (which would mask genuinely missing filters elsewhere).
    const rows = await runUnscoped(
      'user lists their own org memberships',
      ['OrganizationMembership'],
      () =>
        fastify.prisma.organizationMembership.findMany({
          include: {
            organization: {
              include: {
                monthlyUsages: { where: { yearMonth: currentYearMonth() } },
              },
            },
          },
          orderBy: { organization: { name: 'asc' } },
          where: { userId: user.sub },
        })
    );
    return {
      data: rows.map((m) => ({ ...projectOrgBudgetSummary(m.organization), role: m.role })),
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
    return { data: orgs.map(projectOrgBudgetSummary) };
  });

  // GET /api/v1/admin/organizations/:orgId — any org member may read.
  app.get(
    '/:orgId',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }),
      schema: { params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = request.params;
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
      const { orgId } = request.params;
      const body = request.body;
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
