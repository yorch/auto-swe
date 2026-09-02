/**
 * Org-level budget management (P5 billing).
 * Mounted at /api/v1/platform/organizations.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditEntityType, writeAuditLog } from '../lib/auditLog.js';
import { currentYearMonth } from '../lib/orgAccess.js';
import type { JwtPayload } from '../plugins/auth.js';
import { requireAuth } from '../plugins/auth.js';

const OrgParamsSchema = z.object({ orgId: z.string().uuid() });

const PatchBudgetSchema = z.object({
  /** Alert threshold as a percentage of the monthly cap (0-100). Null disables the alert. */
  budgetAlertThresholdPercent: z.number().int().min(0).max(100).nullable(),
  /** Monthly cap in USD cents. Null removes the cap entirely. */
  monthlyBudgetUsdCents: z.number().int().min(0).nullable(),
});

const CurrentMonthUsageSchema = z.object({
  costUsdAccrued: z.number(),
  runsCompleted: z.number().int(),
  tokensInput: z.number(),
  tokensOutput: z.number(),
  yearMonth: z.string(),
});

const BudgetResponseSchema = z.object({
  budgetAlertThresholdPercent: z.number().int().min(0).max(100).nullable(),
  currentMonthUsage: CurrentMonthUsageSchema.nullable(),
  monthlyBudgetUsdCents: z.number().int().min(0).nullable(),
  orgId: z.string().uuid(),
  orgName: z.string(),
});

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const orgBudgetPlugin: FastifyPluginAsync = async (fastify) => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/platform/organizations/:orgId/budget — any org member may read.
  f.get(
    '/:orgId/budget',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_MEMBER' }),
      schema: { response: { 200: BudgetResponseSchema, 404: ErrorResponseSchema } },
    },
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

  // PATCH /api/v1/platform/organizations/:orgId/budget — ORG_ADMIN only.
  f.patch(
    '/:orgId/budget',
    {
      onRequest: requireAuth({ orgIdParam: 'orgId', requiredOrgRole: 'ORG_ADMIN' }),
      schema: {
        body: PatchBudgetSchema,
        params: OrgParamsSchema,
        response: { 200: BudgetResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const { budgetAlertThresholdPercent, monthlyBudgetUsdCents } = PatchBudgetSchema.parse(
        request.body
      );

      const org = await fastify.prisma.organization.findUnique({
        select: {
          budgetAlertThresholdPercent: true,
          monthlyBudgetUsdCents: true,
          name: true,
        },
        where: { id: orgId },
      });
      if (!org) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      const before = {
        budgetAlertThresholdPercent: org.budgetAlertThresholdPercent,
        monthlyBudgetUsdCents: org.monthlyBudgetUsdCents,
      };
      const after = { budgetAlertThresholdPercent, monthlyBudgetUsdCents };

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

      const usage = await fastify.prisma.orgMonthlyUsage.findUnique({
        where: { orgId_yearMonth: { orgId, yearMonth: currentYearMonth() } },
      });

      try {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: request.user as JwtPayload,
          after,
          before,
          entityId: orgId,
          entityType: 'Organization' as AuditEntityType,
        });
      } catch (auditErr) {
        request.log.warn({ auditErr, orgId }, 'failed to write organization budget audit log');
      }

      return {
        budgetAlertThresholdPercent: updated.budgetAlertThresholdPercent,
        currentMonthUsage: usage
          ? {
              costUsdAccrued: Number(usage.costUsdAccrued),
              runsCompleted: usage.runsCompleted,
              tokensInput: Number(usage.tokensInput),
              tokensOutput: Number(usage.tokensOutput),
              yearMonth: usage.yearMonth,
            }
          : null,
        monthlyBudgetUsdCents: updated.monthlyBudgetUsdCents,
        orgId: updated.id,
        orgName: updated.name,
      };
    }
  );
};

export const orgBudgetRoutes = fp(orgBudgetPlugin, {
  fastify: '5.x',
  name: 'org-budget-routes',
});
