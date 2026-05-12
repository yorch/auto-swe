import type { Prisma } from '@auto-swe/shared';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const TemplateIdParam = z.object({ id: z.string().uuid() });
const VersionParam = z.object({ id: z.string().uuid(), version: z.coerce.number().int().min(1) });

const CreateTemplateBody = z.object({
  description: z.string().max(2000).optional(),
  name: z.string().min(1).max(120),
  spec: z.unknown(),
  teamId: z.string().uuid().nullable().optional(),
});

const UpdateTemplateBody = z.object({
  description: z.string().max(2000).optional(),
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});

const CreateVersionBody = z.object({ spec: z.unknown() });
const PromoteBody = z.object({ version: z.number().int().min(1) });
const ListTemplatesQuery = z.object({ teamId: z.string().uuid().optional() });
const ListRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const TEMPLATE_INCLUDE = {
  _count: { select: { versions: true } },
  team: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.WorkflowTemplateInclude;

type TemplateWithIncludes = Prisma.WorkflowTemplateGetPayload<{ include: typeof TEMPLATE_INCLUDE }>;

function teamMembershipFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    OR: [
      { teamId: null }, // Global templates visible to everyone
      { team: { memberships: { some: { userId: user.sub } } } },
    ],
  };
}

interface LastRunRow {
  templateId: string;
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

async function loadLastRuns(
  fastify: FastifyInstance,
  templateIds: string[]
): Promise<Map<string, LastRunRow>> {
  if (templateIds.length === 0) return new Map();
  // One query per template using groupBy would also work, but findMany distinct on
  // (templateId) ordered by startedAt desc is the simpler portable pattern.
  const rows = (await fastify.prisma.workflowRun.findMany({
    distinct: ['templateId'],
    orderBy: { startedAt: 'desc' },
    select: { endedAt: true, id: true, startedAt: true, status: true, templateId: true },
    where: { templateId: { in: templateIds } },
  })) as unknown as LastRunRow[];
  return new Map(rows.map((r) => [r.templateId, r]));
}

function projectTemplate(tpl: TemplateWithIncludes, lastRun: LastRunRow | undefined) {
  return {
    activeVersion: tpl.activeVersion,
    createdAt: tpl.createdAt,
    description: tpl.description,
    id: tpl.id,
    isDefault: tpl.isDefault,
    lastRun: lastRun
      ? {
          endedAt: lastRun.endedAt,
          id: lastRun.id,
          startedAt: lastRun.startedAt,
          status: lastRun.status,
        }
      : null,
    name: tpl.name,
    status: tpl.status,
    team: tpl.team ? { id: tpl.team.id, name: tpl.team.name, slug: tpl.team.slug } : null,
    updatedAt: tpl.updatedAt,
    versionCount: tpl._count.versions,
  };
}

function parseSpecOrThrow(input: unknown): unknown {
  // We accept the spec in whatever schemaVersion the client sent it; the only
  // requirement is that it parses against the current schema. Codemods run on
  // the worker side at run start (templates.ts → migrateSpec).
  const spec = input as { schemaVersion?: unknown } | null;
  if (!spec || typeof spec !== 'object') {
    throw Object.assign(new Error('spec must be an object'), { statusCode: 400 });
  }
  if (spec.schemaVersion !== SPEC_SCHEMA_VERSION) {
    throw Object.assign(
      new Error(
        `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got ${String(spec.schemaVersion)})`
      ),
      { statusCode: 400 }
    );
  }
  try {
    return parseWorkflowSpec(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid spec';
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
}

export const workflowTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List templates ──
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListTemplatesQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.WorkflowTemplateWhereInput = {
        ...teamMembershipFilter(user),
        ...(request.query.teamId ? { teamId: request.query.teamId } : {}),
      };
      const templates = await fastify.prisma.workflowTemplate.findMany({
        include: TEMPLATE_INCLUDE,
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        where,
      });
      const lastRuns = await loadLastRuns(
        fastify,
        templates.map((t) => t.id)
      );
      return { data: templates.map((t) => projectTemplate(t, lastRuns.get(t.id))) };
    }
  );

  // ── Create template ──
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateTemplateBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { name, description, teamId, spec } = request.body;

      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }

      // Non-admins may only create team-owned templates for teams they belong to,
      // and may not create global (teamId = null) templates.
      if (user.role !== 'ADMIN') {
        if (!teamId) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Only admins may create global templates' },
          });
        }
        const member = await fastify.prisma.teamMembership.findFirst({
          where: { teamId, userId: user.sub },
        });
        if (!member) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Not a member of this team' },
          });
        }
      }

      try {
        const tpl = await fastify.prisma.workflowTemplate.create({
          data: {
            description: description ?? '',
            name,
            status: 'DRAFT',
            teamId: teamId ?? null,
            versions: {
              create: { createdBy: user.sub, spec: parsed as object, version: 1 },
            },
          },
          include: TEMPLATE_INCLUDE,
        });
        // Set activeVersion = 1 so the template is immediately usable.
        const promoted = await fastify.prisma.workflowTemplate.update({
          data: { activeVersion: 1, status: 'ACTIVE' },
          include: TEMPLATE_INCLUDE,
          where: { id: tpl.id },
        });
        return reply.status(201).send({ data: projectTemplate(promoted, undefined) });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'P2002') {
          return reply.status(409).send({
            error: { code: 'NAME_CONFLICT', message: 'A template with this name already exists' },
          });
        }
        throw err;
      }
    }
  );

  // ── Get template detail (with versions list + active spec) ──
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        include: {
          ...TEMPLATE_INCLUDE,
          versions: {
            orderBy: { version: 'desc' },
            select: { createdAt: true, createdBy: true, id: true, version: true },
          },
        },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const lastRuns = await loadLastRuns(fastify, [tpl.id]);
      const base = projectTemplate(tpl, lastRuns.get(tpl.id));
      const activeVersionRow = tpl.activeVersion
        ? await fastify.prisma.workflowTemplateVersion.findUnique({
            where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
          })
        : null;
      return {
        data: {
          ...base,
          activeVersionSpec: activeVersionRow
            ? {
                createdAt: activeVersionRow.createdAt,
                createdBy: activeVersionRow.createdBy,
                id: activeVersionRow.id,
                spec: activeVersionRow.spec,
                version: activeVersionRow.version,
              }
            : null,
          versions: tpl.versions,
        },
      };
    }
  );

  // ── Patch metadata (rename, description, default flag, status) ──
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: UpdateTemplateBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }

      // Toggling isDefault has team-wide side effects: ensure exactly one
      // default per (teamId, isDefault=true).
      if (request.body.isDefault === true) {
        await fastify.prisma.workflowTemplate.updateMany({
          data: { isDefault: false },
          where: { id: { not: existing.id }, teamId: existing.teamId },
        });
      }

      const updated = await fastify.prisma.workflowTemplate.update({
        data: request.body,
        include: TEMPLATE_INCLUDE,
        where: { id: existing.id },
      });
      const lastRuns = await loadLastRuns(fastify, [updated.id]);
      return { data: projectTemplate(updated, lastRuns.get(updated.id)) };
    }
  );

  // ── Get a specific version's spec ──
  app.get(
    '/:id/versions/:version',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: VersionParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.findUnique({
        where: {
          templateId_version: { templateId: tpl.id, version: request.params.version },
        },
      });
      if (!version) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
      }
      return {
        data: {
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          id: version.id,
          spec: version.spec,
          version: version.version,
        },
      };
    }
  );

  // ── Create a new version ──
  app.post(
    '/:id/versions',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateVersionBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }

      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(request.body.spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }

      const last = await fastify.prisma.workflowTemplateVersion.findFirst({
        orderBy: { version: 'desc' },
        select: { version: true },
        where: { templateId: tpl.id },
      });
      const next = (last?.version ?? 0) + 1;
      const created = await fastify.prisma.workflowTemplateVersion.create({
        data: {
          createdBy: user.sub,
          spec: parsed as object,
          templateId: tpl.id,
          version: next,
        },
      });
      return reply.status(201).send({
        data: {
          createdAt: created.createdAt,
          createdBy: created.createdBy,
          id: created.id,
          spec: created.spec,
          version: created.version,
        },
      });
    }
  );

  // ── Promote a version to active ──
  app.post(
    '/:id/promote',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: PromoteBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.findUnique({
        where: {
          templateId_version: { templateId: tpl.id, version: request.body.version },
        },
      });
      if (!version) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
      }
      const updated = await fastify.prisma.workflowTemplate.update({
        data: { activeVersion: request.body.version, status: 'ACTIVE' },
        include: TEMPLATE_INCLUDE,
        where: { id: tpl.id },
      });
      const lastRuns = await loadLastRuns(fastify, [updated.id]);
      return { data: projectTemplate(updated, lastRuns.get(updated.id)) };
    }
  );

  // ── Paginated runs for a template ──
  app.get(
    '/:id/runs',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: ListRunsQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const { limit, offset } = request.query;
      const [rows, total] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          include: {
            workRequest: {
              select: { description: true, externalTicketId: true, id: true },
            },
          },
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit,
          where: { templateId: tpl.id },
        }),
        fastify.prisma.workflowRun.count({ where: { templateId: tpl.id } }),
      ]);
      return {
        data: rows.map((r) => ({
          endedAt: r.endedAt,
          id: r.id,
          startedAt: r.startedAt,
          status: r.status,
          templateId: r.templateId,
          templateVersion: r.templateVersion,
          workflowId: r.workflowId,
          workRequest: r.workRequest,
        })),
        meta: { limit, offset, total },
      };
    }
  );
};
