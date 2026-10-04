import {
  SKILL_SOURCE_ERRORS,
  SkillSourceError,
  type SkillSourceErrorCode,
} from '@auto-swe/shared/lib/skillSource';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  installSkillSource,
  previewSkillSource,
  SkillImportRefusal,
} from '../lib/skillSourceService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Admin API for importing skills from an external GitHub / GitHub Enterprise
 * repository. ADMIN-only: imported text becomes agent prompt text, so who may
 * bring it in is a platform decision.
 *
 *   POST   /api/v1/platform/skill-sources/preview   Read a source; writes nothing
 *   POST   /api/v1/platform/skill-sources           Install the chosen skills (one transaction)
 *   GET    /api/v1/platform/skill-sources           List sources
 *   GET    /api/v1/platform/skill-sources/:id       One source, with its skills
 *   PATCH  /api/v1/platform/skill-sources/:id       Change scriptMode, or disable / re-enable
 *   DELETE /api/v1/platform/skill-sources/:id       Remove the source; its skills stay, detached
 */

const SourceIdParams = z.object({ id: z.string().uuid() });

const ScriptModeSchema = z.enum(['TEXT_ONLY', 'REJECT']);

const SourceFields = z.object({
  host: z.string().min(1).max(253).default('github.com'),
  orgId: z.string().uuid().nullish(),
  owner: z.string().min(1).max(100),
  path: z.string().max(1000).default(''),
  ref: z.string().min(1).max(255),
  repo: z.string().min(1).max(100),
  scope: z.enum(['GLOBAL', 'ORGANIZATION', 'TEAM']).default('GLOBAL'),
  scriptMode: ScriptModeSchema.default('TEXT_ONLY'),
  teamId: z.string().uuid().nullish(),
});

/** A GLOBAL source carries no owner; a TEAM or ORGANIZATION one carries exactly its own. */
const scopeIsConsistent = (b: z.infer<typeof SourceFields>) =>
  (b.scope === 'GLOBAL' && !b.teamId && !b.orgId) ||
  (b.scope === 'TEAM' && !!b.teamId && !b.orgId) ||
  (b.scope === 'ORGANIZATION' && !!b.orgId && !b.teamId);
const SCOPE_MESSAGE =
  'scope GLOBAL takes no teamId/orgId; TEAM needs teamId; ORGANIZATION needs orgId';

const PreviewBody = SourceFields.refine(scopeIsConsistent, SCOPE_MESSAGE);

const CreateBody = SourceFields.extend({
  /** The commit the preview showed; the ref must still resolve to it. */
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  skills: z.array(z.string().min(1).max(200)).min(1).max(100),
}).refine(scopeIsConsistent, SCOPE_MESSAGE);

const PatchBody = z
  .object({
    // Changing the mode affects only future updates: what is installed is left alone.
    scriptMode: ScriptModeSchema.optional(),
    status: z.enum(['DISABLED', 'OK']).optional(),
  })
  .refine((b) => b.scriptMode !== undefined || b.status !== undefined, 'nothing to change');

const STATUS_BY_CODE: Record<SkillSourceErrorCode, number> = {
  BAD_PATH: 502,
  BAD_RESPONSE: 502,
  HOST_BLOCKED: 400,
  HOST_NOT_APPROVED: 400,
  HTTP_ERROR: 502,
  INVALID_SOURCE: 400,
  LIMIT_BYTES: 422,
  LIMIT_REQUESTS: 422,
  LIMIT_SKILLS: 422,
  NETWORK: 502,
  NO_SKILLS: 422,
  NOT_FOUND: 404,
  RATE_LIMIT_LOW: 503,
  RATE_LIMITED: 502,
  REDIRECT_BLOCKED: 502,
  SHA_MOVED: 409,
  TIMEOUT: 504,
  TOO_MANY_REDIRECTS: 502,
  TREE_TRUNCATED: 422,
  UNAUTHORIZED: 502,
};

const PUBLIC_SOURCE_SELECT = {
  createdAt: true,
  host: true,
  id: true,
  lastCheckedAt: true,
  lastError: true,
  latestSha: true,
  orgId: true,
  owner: true,
  path: true,
  pinnedSha: true,
  ref: true,
  repo: true,
  scope: true,
  scriptMode: true,
  status: true,
  teamId: true,
  updatedAt: true,
} as const;

export const skillSourceRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  /** A fetch failure as its fixed string; anything unexpected is rethrown to the error handler. */
  const sourceError = (err: unknown, reply: FastifyReply) => {
    if (!(err instanceof SkillSourceError)) {
      throw err;
    }
    return reply.status(STATUS_BY_CODE[err.code]).send({
      error: { code: `SKILL_SOURCE_${err.code}`, message: SKILL_SOURCE_ERRORS[err.code] },
    });
  };

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill source not found' } });

  /** TEAM / ORGANIZATION sources need a real owner; a bad id is a 400, not a foreign-key 500. */
  async function ownerExists(body: z.infer<typeof SourceFields>): Promise<boolean> {
    if (body.scope === 'TEAM') {
      return !!(await fastify.prisma.team.findUnique({
        select: { id: true },
        where: { id: body.teamId as string },
      }));
    }
    if (body.scope === 'ORGANIZATION') {
      return !!(await fastify.prisma.organization.findUnique({
        select: { id: true },
        where: { id: body.orgId as string },
      }));
    }
    return true;
  }

  // POST /skill-sources/preview — reads the source, writes nothing.
  app.post(
    '/skill-sources/preview',
    { onRequest: adminOnly, schema: { body: PreviewBody } },
    async (request, reply) => {
      const body = request.body;
      try {
        const result = await previewSkillSource(fastify.prisma, {
          ...body,
          orgId: body.orgId ?? null,
          teamId: body.teamId ?? null,
        });
        return { data: { location: result.location, sha: result.sha, skills: result.skills } };
      } catch (err) {
        return sourceError(err, reply);
      }
    }
  );

  // POST /skill-sources — install the chosen skills at the previewed commit.
  app.post(
    '/skill-sources',
    { onRequest: adminOnly, schema: { body: CreateBody } },
    async (request, reply) => {
      const actor = requireUser(request);
      const body = request.body;
      if (!(await ownerExists(body))) {
        return reply.status(400).send({
          error: { code: 'INVALID_OWNER', message: 'The team or organization does not exist' },
        });
      }
      try {
        const { source, installed } = await installSkillSource(
          fastify.prisma,
          {
            ...body,
            createdById: actor.sub,
            orgId: body.orgId ?? null,
            teamId: body.teamId ?? null,
          },
          (tx, created, skills) =>
            writeAuditLog(fastify, {
              action: 'CREATE',
              actor,
              // The normalised row, not the request: what was stored is what is recorded.
              after: {
                host: created.host,
                owner: created.owner,
                path: created.path,
                pinnedSha: created.pinnedSha,
                ref: created.ref,
                repo: created.repo,
                scope: created.scope,
                scriptMode: created.scriptMode,
                skills: skills.map((s) => s.name),
              },
              client: tx,
              entityId: created.id,
              entityType: 'SkillSource',
            })
        );
        return reply.status(201).send({ data: { skills: installed, source } });
      } catch (err) {
        if (err instanceof SkillImportRefusal) {
          const status =
            err.code === 'UNKNOWN_SKILLS' ? 400 : err.code === 'NAME_CONFLICT' ? 409 : 422;
          return reply.status(status).send({
            error: {
              code: `SKILL_IMPORT_${err.code}`,
              details: err.details,
              message: IMPORT_MESSAGES[err.code],
            },
          });
        }
        if ((err as { code?: unknown } | null)?.code === 'P2002') {
          return reply.status(409).send({
            error: {
              code: 'SKILL_SOURCE_EXISTS',
              message: 'This repository path is already a skill source in this scope',
            },
          });
        }
        return sourceError(err, reply);
      }
    }
  );

  // GET /skill-sources
  app.get('/skill-sources', { onRequest: adminOnly }, async () => {
    const rows = await runUnscoped('admin skill sources span every tenant', ['SkillSource'], () =>
      fastify.prisma.skillSource.findMany({
        orderBy: [{ host: 'asc' }, { owner: 'asc' }, { repo: 'asc' }, { path: 'asc' }],
        select: { ...PUBLIC_SOURCE_SELECT, _count: { select: { skills: true } } },
      })
    );
    return { data: rows.map(({ _count, ...r }) => ({ ...r, skillCount: _count.skills })) };
  });

  // GET /skill-sources/:id
  app.get(
    '/skill-sources/:id',
    { onRequest: adminOnly, schema: { params: SourceIdParams } },
    async (request, reply) => {
      const row = await fastify.prisma.skillSource.findUnique({
        select: {
          ...PUBLIC_SOURCE_SELECT,
          skills: {
            orderBy: { name: 'asc' },
            select: {
              currentRevision: true,
              id: true,
              isVerified: true,
              name: true,
              sourcePath: true,
            },
          },
        },
        where: { id: request.params.id },
      });
      return row ? { data: row } : notFound(reply);
    }
  );

  // PATCH /skill-sources/:id
  app.patch(
    '/skill-sources/:id',
    { onRequest: adminOnly, schema: { body: PatchBody, params: SourceIdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skillSource.findUnique({
        select: PUBLIC_SOURCE_SELECT,
        where: { id: request.params.id },
      });
      if (!existing) {
        return notFound(reply);
      }
      const { scriptMode, status } = request.body;
      // Re-enabling restores what the last check found rather than guessing OK.
      const nextStatus =
        status === undefined
          ? undefined
          : status === 'OK' && existing.latestSha && existing.latestSha !== existing.pinnedSha
            ? 'UPDATE_AVAILABLE'
            : status;
      const updated = await fastify.prisma.skillSource.update({
        data: { scriptMode, status: nextStatus },
        select: PUBLIC_SOURCE_SELECT,
        where: { id: existing.id },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { scriptMode: updated.scriptMode, status: updated.status },
        before: { scriptMode: existing.scriptMode, status: existing.status },
        entityId: existing.id,
        entityType: 'SkillSource',
      });
      return { data: updated };
    }
  );

  // DELETE /skill-sources/:id — the skills stay (the FK detaches them) as ordinary
  // custom skills, keeping the provenance their revisions carry.
  app.delete(
    '/skill-sources/:id',
    { onRequest: adminOnly, schema: { params: SourceIdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skillSource.findUnique({
        select: { ...PUBLIC_SOURCE_SELECT, skills: { select: { id: true, name: true } } },
        where: { id: request.params.id },
      });
      if (!existing) {
        return notFound(reply);
      }
      await fastify.prisma.$transaction(async (tx) => {
        await tx.skillSource.delete({ where: { id: existing.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          before: {
            detachedSkills: existing.skills.map((s) => s.name),
            host: existing.host,
            owner: existing.owner,
            path: existing.path,
            pinnedSha: existing.pinnedSha,
            ref: existing.ref,
            repo: existing.repo,
          },
          client: tx,
          entityId: existing.id,
          entityType: 'SkillSource',
        });
      });
      return reply.status(204).send();
    }
  );
};

const IMPORT_MESSAGES = {
  NAME_CONFLICT:
    'A skill with the same name already exists; nothing was imported. Rename or remove it, or leave the skill out.',
  NOT_INSTALLABLE: 'Some chosen skills have errors and cannot be installed; nothing was imported.',
  SCAN_WARNINGS:
    'Some chosen skills drew scanner warnings and skills.import.blockOnScanWarnings is on; nothing was imported.',
  UNKNOWN_SKILLS: 'Some chosen skills are not in the source at that commit; nothing was imported.',
} as const;
