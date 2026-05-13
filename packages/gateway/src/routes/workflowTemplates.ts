import type { Prisma } from '@auto-swe/shared';
import { WORKFLOW_TEMPLATE_STATUSES } from '@auto-swe/shared/types/api';
import {
  assertShellImageAllowed,
  computeAnalytics,
  diffSpecs,
  parseWorkflowSpec,
  ShellImageNotAllowedError,
  type ShellNode,
  SPEC_SCHEMA_VERSION,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { projectRunSummary, RunListPaginationQuery } from './workflowProjections.js';

interface ShellNodeWithId {
  id: string;
  node: ShellNode;
}

function collectShellNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'shell') out.push({ id, node });
  }
  return out;
}

/**
 * Phase-6 RBAC: authoring a spec with any shell node requires the
 * `workflow:write:shell` permission. We map it to:
 *   - platform ADMIN, OR
 *   - team-role ADMIN in the template's owning team (templates with
 *     teamId === null are global → only platform ADMINs may save shell
 *     nodes there).
 * Returns a Fastify reply on failure, or null on success.
 */
async function assertShellAuthoringAllowed(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<{ statusCode: number; body: unknown } | null> {
  if (shellNodes.length === 0) return null;
  if (user.role === 'ADMIN') return null;
  if (teamId === null) {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Only platform admins may author shell steps on global templates',
        },
      },
      statusCode: 403,
    };
  }
  const membership = await fastify.prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (!membership || membership.role !== 'ADMIN') {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Authoring shell steps requires team-admin role',
        },
      },
      statusCode: 403,
    };
  }
  return null;
}

async function assertShellImagesAllowed(
  fastify: FastifyInstance,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<{ statusCode: number; body: unknown } | null> {
  if (shellNodes.length === 0) return null;
  const teamAllowlist = teamId
    ? ((
        await fastify.prisma.team.findUnique({
          select: { shellImageAllowlist: true },
          where: { id: teamId },
        })
      )?.shellImageAllowlist ?? [])
    : [];
  for (const { id, node } of shellNodes) {
    try {
      assertShellImageAllowed(node.image, teamAllowlist);
    } catch (err) {
      if (err instanceof ShellImageNotAllowedError) {
        return {
          body: {
            error: {
              code: 'SHELL_IMAGE_NOT_ALLOWED',
              message: `Node '${id}': ${err.message}`,
            },
          },
          statusCode: 400,
        };
      }
      throw err;
    }
  }
  return null;
}

async function recordShellAudit(
  fastify: FastifyInstance,
  templateVersionId: string,
  teamId: string | null,
  authorUserId: string,
  shellNodes: ShellNodeWithId[]
): Promise<void> {
  if (shellNodes.length === 0) return;
  await fastify.prisma.workflowShellAudit.createMany({
    data: shellNodes.map(({ id, node }) => ({
      authorUserId,
      command: node.command,
      image: node.image,
      network: node.network ?? 'none',
      nodeId: id,
      teamId,
      templateVersionId,
    })),
  });
}

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
  experimentSplit: z.number().int().min(0).max(100).nullable().optional(),
  experimentVersion: z.number().int().min(1).nullable().optional(),
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  status: z.enum(WORKFLOW_TEMPLATE_STATUSES).optional(),
});

const CreateVersionBody = z.object({ spec: z.unknown() });
const PromoteBody = z.object({ version: z.number().int().min(1) });
const ListTemplatesQuery = z.object({ teamId: z.string().uuid().optional() });
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
    experimentSplit: tpl.experimentSplit,
    experimentVersion: tpl.experimentVersion,
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
  // Strict check: the spec must already declare the current SPEC_SCHEMA_VERSION.
  // Codemods exist (and run at workflow start in templates.ts → migrateSpec) for
  // already-stored specs, but the editor is expected to migrate before saving,
  // so we don't auto-upgrade here — otherwise older clients could silently
  // round-trip a spec they don't fully understand.
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

      const parsedSpec = parsed as WorkflowSpec;
      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, teamId ?? null, shellNodes),
        assertShellImagesAllowed(fastify, teamId ?? null, shellNodes),
      ]);
      if (rbac) return reply.status(rbac.statusCode).send(rbac.body);
      if (imgGate) return reply.status(imgGate.statusCode).send(imgGate.body);

      try {
        // Single create — `activeVersion: 1` + `status: 'ACTIVE'` are set inline
        // so a failure can't leave a half-promoted template behind.
        const tpl = await fastify.prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: description ?? '',
            name,
            status: 'ACTIVE',
            teamId: teamId ?? null,
            versions: {
              create: { createdBy: user.sub, spec: parsed as object, version: 1 },
            },
          },
          include: { ...TEMPLATE_INCLUDE, versions: { select: { id: true, version: true } } },
        });
        const initialVersion = tpl.versions[0];
        if (initialVersion) {
          await recordShellAudit(fastify, initialVersion.id, teamId ?? null, user.sub, shellNodes);
        }
        return reply.status(201).send({ data: projectTemplate(tpl, undefined) });
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

      // Experiment-config validation. Done at PATCH time (vs. a CHECK constraint)
      // because the rule depends on a sibling row (the version must exist for
      // this template) which Postgres can't express cheaply.
      const expVersion = request.body.experimentVersion;
      const expSplit = request.body.experimentSplit;
      if (expVersion !== undefined && expVersion !== null) {
        const v = await fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: existing.id, version: expVersion } },
        });
        if (!v) {
          return reply.status(400).send({
            error: {
              code: 'EXPERIMENT_VERSION_NOT_FOUND',
              message: `Version ${expVersion} does not exist on this template`,
            },
          });
        }
      }
      // Enabling traffic split without a destination version is meaningless and
      // would silently no-op in the resolver — reject it up front.
      const nextExpVersion = expVersion !== undefined ? expVersion : existing.experimentVersion;
      const nextExpSplit = expSplit !== undefined ? expSplit : existing.experimentSplit;
      if (nextExpSplit !== null && nextExpSplit > 0 && nextExpVersion === null) {
        return reply.status(400).send({
          error: {
            code: 'EXPERIMENT_VERSION_REQUIRED',
            message: 'experimentSplit > 0 requires experimentVersion to be set',
          },
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

      const parsedSpec = parsed as WorkflowSpec;
      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, tpl.teamId, shellNodes),
        assertShellImagesAllowed(fastify, tpl.teamId, shellNodes),
      ]);
      if (rbac) return reply.status(rbac.statusCode).send(rbac.body);
      if (imgGate) return reply.status(imgGate.statusCode).send(imgGate.body);

      // SELECT max(version)+1 / INSERT is racy under concurrent saves — two
      // simultaneous POSTs would pick the same `next`, and Prisma's unique
      // (templateId, version) constraint would 500 the loser. Retry on
      // P2002 with a fresh max; bounded so a runaway loop can't spin forever.
      const MAX_RETRIES = 5;
      let created: Awaited<
        ReturnType<typeof fastify.prisma.workflowTemplateVersion.create>
      > | null = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const last = await fastify.prisma.workflowTemplateVersion.findFirst({
          orderBy: { version: 'desc' },
          select: { version: true },
          where: { templateId: tpl.id },
        });
        const next = (last?.version ?? 0) + 1;
        try {
          created = await fastify.prisma.workflowTemplateVersion.create({
            data: {
              createdBy: user.sub,
              spec: parsed as object,
              templateId: tpl.id,
              version: next,
            },
          });
          break;
        } catch (err: unknown) {
          const e = err as { code?: string };
          if (e.code !== 'P2002' || attempt === MAX_RETRIES - 1) throw err;
        }
      }
      if (!created) {
        return reply.status(409).send({
          error: { code: 'VERSION_CONFLICT', message: 'Concurrent version writes — please retry' },
        });
      }
      await recordShellAudit(fastify, created.id, tpl.teamId, user.sub, shellNodes);
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
      schema: { params: TemplateIdParam, querystring: RunListPaginationQuery },
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
        data: rows.map(projectRunSummary),
        meta: { limit, offset, total },
      };
    }
  );

  // ── Spec diff between two versions ──
  // GET /:id/diff?a=<version>&b=<version>
  // Returns the structural diff between two versions of the same template,
  // so the editor can paint added/removed/changed nodes in the DAG.
  const DiffQuery = z.object({
    a: z.coerce.number().int().min(1),
    b: z.coerce.number().int().min(1),
  });
  app.get(
    '/:id/diff',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: DiffQuery },
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
      const [verA, verB] = await Promise.all([
        fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: tpl.id, version: request.query.a } },
        }),
        fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: tpl.id, version: request.query.b } },
        }),
      ]);
      if (!verA || !verB) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'One or both versions not found' },
        });
      }
      // `spec` is stored as parsed JSON; cast at the boundary. Both rows were
      // validated against WorkflowSpecSchema when they landed, so the cast is safe.
      const specA = verA.spec as unknown as WorkflowSpec;
      const specB = verB.spec as unknown as WorkflowSpec;
      const diff = diffSpecs(specA, specB);
      return {
        data: {
          a: { spec: specA, version: verA.version },
          b: { spec: specB, version: verB.version },
          diff,
        },
      };
    }
  );

  // ── Analytics for a template ──
  // GET /:id/analytics?window=<days>
  // Aggregates from workflow_runs + workflow_steps. Cost data is joined via
  // workRequest → activeWorkflow (cost accrues on the Temporal workflow, not
  // the per-run record).
  const AnalyticsQuery = z.object({
    window: z.coerce.number().int().min(1).max(365).default(30),
  });
  app.get(
    '/:id/analytics',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: AnalyticsQuery },
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
      const windowStart = new Date(Date.now() - request.query.window * 24 * 60 * 60 * 1000);
      // Hard cap on rows pulled into memory. Templates with high run volume
      // would otherwise OOM the gateway on a 90d window. At the cap the rollup
      // becomes an approximation of the most recent N runs/steps in the window.
      const ANALYTICS_ROW_CAP = 10_000;

      const [runs, steps] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          orderBy: { startedAt: 'desc' },
          select: {
            endedAt: true,
            startedAt: true,
            status: true,
            templateVersion: true,
            workRequest: {
              select: {
                activeWorkflows: { select: { costUsdAccrued: true } },
              },
            },
          },
          take: ANALYTICS_ROW_CAP,
          where: { startedAt: { gte: windowStart }, templateId: tpl.id },
        }),
        fastify.prisma.workflowStep.findMany({
          orderBy: { startedAt: 'desc' },
          select: { nodeId: true, status: true },
          take: ANALYTICS_ROW_CAP,
          where: { run: { startedAt: { gte: windowStart }, templateId: tpl.id } },
        }),
      ]);

      return { data: computeAnalytics(runs, steps, request.query.window) };
    }
  );
};
