import type { Prisma } from '@auto-swe/shared';
import { isRevisionConflict } from '@auto-swe/shared/lib/skillRevision';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { updateSkill } from '../lib/skillLibraryService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Revision history of one skill, and restoring an old revision.
 *
 *   GET  /api/v1/platform/skills/:id/revisions                       newest first
 *   POST /api/v1/platform/skills/:id/revisions/:revision/restore     cut a NEW revision from an old one
 *
 * Revisions are immutable, so a restore appends a revision carrying the old text rather than
 * moving `currentRevision` back — runs pinned to any revision keep reading it. Built-in skills
 * take their text from code and cannot be restored.
 */

const IdParams = z.object({ id: z.string().uuid() });
const RevisionParams = IdParams.extend({ revision: z.coerce.number().int().positive() });

export const skillRevisionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  app.get(
    '/skills/:id/revisions',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const skill = await fastify.prisma.skill.findUnique({
        select: { currentRevision: true, id: true },
        where: { id: request.params.id },
      });
      if (!skill) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      const revisions = await fastify.prisma.skillRevision.findMany({
        include: { createdBy: { select: { email: true } } },
        orderBy: { revision: 'desc' },
        where: { skillId: skill.id },
      });
      return {
        data: revisions.map(({ createdBy, referenceFiles: _files, ...r }) => ({
          ...r,
          createdByEmail: createdBy?.email ?? null,
          isCurrent: r.revision === skill.currentRevision,
        })),
      };
    }
  );

  app.post(
    '/skills/:id/revisions/:revision/restore',
    { onRequest: adminOnly, schema: { params: RevisionParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.skill.findUnique({ where: { id: request.params.id } });
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Skill not found' } });
      }
      if (existing.isBuiltIn) {
        return reply.status(403).send({
          error: {
            code: 'BUILTIN_SKILL',
            message: 'Built-in skills take their text from the platform and cannot be restored.',
          },
        });
      }
      const source = await fastify.prisma.skillRevision.findUnique({
        where: {
          skillId_revision: { revision: request.params.revision, skillId: existing.id },
        },
      });
      if (!source) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Revision not found' } });
      }
      if (source.revision === existing.currentRevision) {
        return reply.status(409).send({
          error: { code: 'ALREADY_CURRENT', message: 'That revision is already the current one.' },
        });
      }
      let result: Awaited<ReturnType<typeof updateSkill>>;
      try {
        result = await updateSkill(
          fastify.prisma,
          existing,
          { description: source.description ?? undefined, promptText: source.promptText },
          actor.sub,
          // The restored text keeps the repository, path and files it was imported from.
          source.sourceSha
            ? {
                referenceFiles: (source.referenceFiles ?? null) as Prisma.InputJsonValue | null,
                sourcePath: source.sourcePath,
                sourceSha: source.sourceSha,
              }
            : {}
        );
      } catch (err) {
        if (isRevisionConflict(err)) {
          return reply.status(409).send({
            error: {
              code: 'SKILL_CHANGED',
              message: 'The skill changed since you read it; reload it and try again.',
            },
          });
        }
        throw err;
      }
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { restoredFromRevision: source.revision, revision: result.updated.currentRevision },
        before: { revision: existing.currentRevision },
        entityId: existing.id,
        entityType: 'Skill',
      });
      return reply.status(201).send({
        data: result.updated,
        ...(result.scanWarnings.length > 0 ? { scanWarnings: result.scanWarnings } : {}),
      });
    }
  );
};
