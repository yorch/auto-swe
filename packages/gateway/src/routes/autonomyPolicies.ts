import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const RuleSchema = z.record(
  z.string().min(1),
  z.object({
    action: z.enum(['auto', 'require_approval']),
  })
);

const CreateSchema = z.object({
  description: z.string().max(500).optional(),
  isDefault: z.boolean().default(false),
  name: z.string().min(1).max(200),
  rules: RuleSchema,
  teamId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
});

const UpdateSchema = z.object({
  description: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(200).optional(),
  rules: RuleSchema.optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const PolicyListResponseSchema = z.object({ data: z.array(z.unknown()) });
const PolicyDetailResponseSchema = z.object({ data: z.unknown() });
const DeletePolicyResponseSchema = z.object({ data: z.object({ deleted: z.boolean() }) });

function scopeError(): { code: string; message: string } {
  return {
    code: 'INVALID_SCOPE',
    message:
      'A policy must have exactly one scope: global default (isDefault=true, no team/template), team default (teamId only), or template override (templateId only).',
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
  if (!isDefault && hasTeam && !hasTemplate) {
    return true;
  }
  if (!isDefault && !hasTeam && hasTemplate) {
    return true;
  }
  return false;
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
      return { data: rows };
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
        return reply.status(201).send({ data: row });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Unique constraint')) {
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
      return { data: row };
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
      return { data: updated };
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
