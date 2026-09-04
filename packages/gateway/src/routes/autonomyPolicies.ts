import { Prisma } from '@auto-swe/shared';
import { AutonomyRulesSchema } from '@auto-swe/shared/lib/autonomyPolicy';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { paginationQuery } from '../lib/pagination.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import {
  AutonomyDecisionSchema,
  PaginationMetaSchema,
  projectAutonomyDecision,
} from './workflowProjections.js';

const CreateSchema = z.object({
  description: z.string().max(500).optional(),
  isDefault: z.boolean().default(false),
  name: z.string().min(1).max(200),
  rules: AutonomyRulesSchema,
  teamId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
});

const UpdateSchema = z.object({
  description: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  rules: AutonomyRulesSchema.optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const PolicyTeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

const PolicyTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

const PolicySchema = z.object({
  createdAt: z.string(),
  description: z.string().nullable(),
  id: z.string().uuid(),
  isDefault: z.boolean(),
  name: z.string(),
  rules: AutonomyRulesSchema,
  team: PolicyTeamSchema.nullable(),
  teamId: z.string().uuid().nullable(),
  template: PolicyTemplateSchema.nullable(),
  templateId: z.string().uuid().nullable(),
  updatedAt: z.string(),
});

const PolicyListResponseSchema = z.object({ data: z.array(PolicySchema) });
const PolicyDetailResponseSchema = z.object({ data: PolicySchema });
const DeletePolicyResponseSchema = z.object({ data: z.object({ deleted: z.boolean() }) });

const DecisionsQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend({
  actorId: z.string().uuid().optional(),
  event: z.string().max(100).optional(),
  policyName: z.string().max(200).optional(),
  riskClass: z.string().max(200).optional(),
  runId: z.string().uuid().optional(),
});

const AutonomyDecisionListResponseSchema = z.object({
  data: z.array(AutonomyDecisionSchema),
  meta: PaginationMetaSchema,
});

function scopeError(): { code: string; message: string } {
  return {
    code: 'INVALID_SCOPE',
    message:
      'A policy must have exactly one scope: global default (isDefault=true, no team/template), team default (isDefault=true + teamId), or template override (templateId only).',
  };
}

function validateScope(body: {
  isDefault?: boolean;
  teamId?: string | null;
  templateId?: string | null;
}): boolean {
  const isDefault = body.isDefault === true;
  const hasTeam = body.teamId != null;
  const hasTemplate = body.templateId != null;
  if (isDefault && !hasTeam && !hasTemplate) {
    return true;
  }
  if (isDefault && hasTeam && !hasTemplate) {
    return true;
  }
  if (!isDefault && !hasTeam && hasTemplate) {
    return true;
  }
  return false;
}

function toPolicyResponseDto(row: object): z.infer<typeof PolicySchema> {
  const r = row as Record<string, unknown>;
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  } as z.infer<typeof PolicySchema>;
}

export const autonomyPolicyRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get(
    '/autonomy-policies',
    { onRequest: adminOnly, schema: { response: { 200: PolicyListResponseSchema } } },
    async () => {
      const rows = await runUnscoped('admin lists all autonomy policies', ['AutonomyPolicy'], () =>
        fastify.prisma.autonomyPolicy.findMany({
          include: {
            team: { select: { id: true, name: true, slug: true } },
            template: { select: { id: true, name: true } },
          },
          orderBy: { name: 'asc' },
        })
      );
      return { data: rows.map(toPolicyResponseDto) };
    }
  );

  // ── Global autonomy-decision audit (ADMIN only) ──
  app.get(
    '/autonomy-decisions',
    {
      onRequest: adminOnly,
      schema: {
        querystring: DecisionsQuery,
        response: { 200: AutonomyDecisionListResponseSchema },
      },
    },
    async (request) => {
      const { actorId, event, limit, offset, policyName, riskClass, runId } = request.query;
      const where: Prisma.AutonomyDecisionWhereInput = {
        ...(actorId ? { actorId } : {}),
        ...(event ? { event: { contains: event, mode: 'insensitive' } } : {}),
        ...(policyName ? { policyName: { contains: policyName, mode: 'insensitive' } } : {}),
        ...(riskClass ? { riskClass: { contains: riskClass, mode: 'insensitive' } } : {}),
        ...(runId ? { runId } : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.autonomyDecision.findMany({
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.autonomyDecision.count({ where }),
      ]);
      const data = rows.map(projectAutonomyDecision);
      return { data, meta: { limit, offset, total } };
    }
  );

  app.post(
    '/autonomy-policies',
    {
      onRequest: adminOnly,
      schema: {
        body: CreateSchema,
        response: {
          201: PolicyDetailResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      if (!validateScope(request.body)) {
        return reply.status(400).send({ error: scopeError() });
      }
      const { description, isDefault, name, rules, teamId, templateId } = request.body;
      try {
        const row = await fastify.prisma.autonomyPolicy.create({
          data: {
            description,
            isDefault,
            name,
            rules,
            teamId: teamId ?? null,
            templateId: templateId ?? null,
          },
          include: {
            team: { select: { id: true, name: true, slug: true } },
            template: { select: { id: true, name: true } },
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { description, isDefault, name, rules, teamId, templateId },
          entityId: row.id,
          entityType: 'AutonomyPolicy',
        });
        return reply.status(201).send({ data: toPolicyResponseDto(row) });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.status(409).send({
            error: {
              code: 'DUPLICATE_POLICY',
              message: 'A policy already exists at this scope.',
            },
          });
        }
        throw err;
      }
    }
  );

  app.get(
    '/autonomy-policies/:id',
    {
      onRequest: adminOnly,
      schema: {
        params: IdParams,
        response: { 200: PolicyDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const row = await fastify.prisma.autonomyPolicy.findUnique({
        include: {
          team: { select: { id: true, name: true, slug: true } },
          template: { select: { id: true, name: true } },
        },
        where: { id: request.params.id },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
      }
      return { data: toPolicyResponseDto(row) };
    }
  );

  app.patch(
    '/autonomy-policies/:id',
    {
      onRequest: adminOnly,
      schema: {
        body: UpdateSchema,
        params: IdParams,
        response: {
          200: PolicyDetailResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.autonomyPolicy.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
      }
      const data = request.body;
      if (!validateScope({ ...existing, ...data })) {
        return reply.status(400).send({ error: scopeError() });
      }
      const updated = await fastify.prisma.autonomyPolicy.update({
        data,
        include: {
          team: { select: { id: true, name: true, slug: true } },
          template: { select: { id: true, name: true } },
        },
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: data,
        before: existing,
        entityId: existing.id,
        entityType: 'AutonomyPolicy',
      });
      return { data: toPolicyResponseDto(updated) };
    }
  );

  app.delete(
    '/autonomy-policies/:id',
    {
      onRequest: adminOnly,
      schema: {
        params: IdParams,
        response: { 200: DeletePolicyResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.autonomyPolicy.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
      }
      await fastify.prisma.autonomyPolicy.delete({ where: { id: existing.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: existing,
        entityId: existing.id,
        entityType: 'AutonomyPolicy',
      });
      return { data: { deleted: true } };
    }
  );
};
