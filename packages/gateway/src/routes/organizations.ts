import { Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isPlatformAdmin, orgIsAdmin } from '@auto-swe/shared/permissions';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditContextOf } from '../lib/auditContext.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { can, replyRefusal } from '../lib/authz.js';
import { sendError } from '../lib/httpErrors.js';
import { currentYearMonth } from '../lib/orgAccess.js';
import { changeOrganizationActive } from '../lib/organizationDeactivation.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });

const PatchOrgSchema = z.object({
  // Platform-ADMIN only: deactivating closes the organization's open join requests.
  isActive: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case')
    .optional(),
  // Platform-ADMIN only: an org must not be able to trust its own invites.
  trustedInvites: z.boolean().optional(),
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
  isActive: boolean;
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
    isActive: org.isActive,
    monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
    name: org.name,
    slug: org.slug,
  };
}

/**
 * What a plain ORG_MEMBER may read of an organization's budget: the alert (a percentage and
 * whether it fired) and the threshold, never the cap or the spend in dollars.
 */
function withoutBudgetDollars<T extends ReturnType<typeof projectOrgBudgetSummary>>(summary: T) {
  const { alert, currentMonthUsage: _usage, monthlyBudgetUsdCents: _cap, ...rest } = summary;
  // The raw ratio of spend to cap would let a reader reconstruct the cap, so the percentage is
  // rounded to one decimal, as `budgetStatusFor` does. `triggered` is computed before rounding.
  return {
    ...rest,
    alert: {
      percent: alert.percent == null ? null : Math.round(alert.percent * 10) / 10,
      triggered: alert.triggered,
    },
  };
}

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // List organizations the current user is a member of, with budget + alert state.
  app.get('/', { onRequest: requireAuth() }, async (request) => {
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
    // The cap and the spend in dollars are an organization administrator's (and a platform administrator's) to read.
    return {
      data: rows.map((m) => {
        const summary = projectOrgBudgetSummary(m.organization);
        return {
          ...(orgIsAdmin(m.role) || isPlatformAdmin(user)
            ? summary
            : withoutBudgetDollars(summary)),
          role: m.role,
        };
      }),
    };
  });

  // GET /api/v1/platform/organizations/budget-alerts — platform ADMIN view of alerting orgs. A
  // deactivated organization is listed only on request (`includeInactive=true`), so the admin list
  // can show it and offer reactivation while organization pickers keep to active ones.
  app.get(
    '/budget-alerts',
    {
      onRequest: requireAuth({ capability: 'platform.budgets.read-all' }),
      schema: { querystring: z.object({ includeInactive: booleanQueryParam() }) },
    },
    async (request) => {
      const orgs = await fastify.prisma.organization.findMany({
        include: {
          monthlyUsages: { where: { yearMonth: currentYearMonth() } },
        },
        orderBy: { name: 'asc' },
        where: request.query.includeInactive ? {} : { isActive: true },
      });
      return { data: orgs.map(projectOrgBudgetSummary) };
    }
  );

  // GET /api/v1/platform/organizations/:orgId — any org member may read; the monthly cap is an
  // administrator's, so a member's response omits it.
  app.get(
    '/:orgId',
    {
      onRequest: requireAuth({ capability: 'org.read', org: { param: 'orgId' } }),
      schema: { params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const org = await fastify.prisma.organization.findUnique({
        select: {
          budgetAlertThresholdPercent: true,
          id: true,
          isActive: true,
          monthlyBudgetUsdCents: true,
          name: true,
          slug: true,
          trustedInvites: true,
        },
        where: { id: orgId },
      });
      if (!org) {
        return sendError(reply, 404, 'NOT_FOUND', 'Organization not found');
      }
      if (!(await can(request, 'org.budget.manage', { orgId })).allowed) {
        const { monthlyBudgetUsdCents: _cap, ...visible } = org;
        return { data: visible };
      }
      return { data: org };
    }
  );

  // PATCH /api/v1/platform/organizations/:orgId — ORG_ADMIN can update name/slug;
  // `trustedInvites` and `isActive` are a platform ADMIN's decision.
  app.patch(
    '/:orgId',
    {
      onRequest: requireAuth({ capability: 'org.settings.manage', org: { param: 'orgId' } }),
      schema: { body: PatchOrgSchema, params: OrgParamsSchema },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const body = request.body;
      if (Object.keys(body).length === 0) {
        return sendError(reply, 400, 'INVALID_BODY', 'No fields to update');
      }
      if (
        body.trustedInvites !== undefined &&
        !(await can(request, 'platform.orgs.trust-invites.manage')).allowed
      ) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only a platform admin can change whether an organization is trusted'
        );
      }

      if (body.isActive !== undefined) {
        const decision = await can(request, 'platform.orgs.deactivate');
        if (!decision.allowed) {
          return replyRefusal(reply, decision);
        }
        const { isActive, ...fields } = body;
        try {
          const outcome = await changeOrganizationActive(fastify, {
            actor: requireUser(request),
            context: { ...auditContextOf(request), authority: decision.authority },
            fields,
            isActive,
            orgId,
          });
          if (!outcome.ok) {
            return sendError(reply, outcome.status, outcome.code, outcome.message);
          }
          return { data: outcome.organization };
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            return sendError(reply, 409, 'ORG_EXISTS', 'Organization name or slug already in use');
          }
          throw e;
        }
      }

      const existing = await fastify.prisma.organization.findUnique({
        select: { id: true, name: true, slug: true, trustedInvites: true },
        where: { id: orgId },
      });
      if (!existing) {
        return sendError(reply, 404, 'NOT_FOUND', 'Organization not found');
      }

      try {
        const updated = await fastify.prisma.organization.update({
          data: body,
          select: { id: true, name: true, slug: true, trustedInvites: true },
          where: { id: orgId },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: requireUser(request),
          after: {
            name: updated.name,
            slug: updated.slug,
            trustedInvites: updated.trustedInvites,
          },
          before: {
            name: existing.name,
            slug: existing.slug,
            trustedInvites: existing.trustedInvites,
          },
          entityId: orgId,
          entityType: 'Organization',
        });
        return { data: updated };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return sendError(reply, 409, 'ORG_EXISTS', 'Organization name or slug already in use');
        }
        throw e;
      }
    }
  );
};
