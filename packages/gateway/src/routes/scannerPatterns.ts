import { invalidateScannerPatternCache } from '@auto-swe/shared/lib/skillScanner';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const PATTERN_TYPES = ['INJECTION', 'EXFILTRATION'] as const;

const PatternIdParams = z.object({ id: z.string().uuid() });

const CreatePatternSchema = z.object({
  flags: z.string().max(10).default(''),
  label: z.string().min(1).max(200),
  pattern: z.string().min(1).max(2000),
  type: z.enum(PATTERN_TYPES),
});

const UpdatePatternSchema = z.object({
  flags: z.string().max(10).optional(),
  isActive: z.boolean().optional(),
  label: z.string().min(1).max(200).optional(),
  pattern: z.string().min(1).max(2000).optional(),
  type: z.enum(PATTERN_TYPES).optional(),
});

function validateRegex(pattern: string, flags: string): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regular expression';
  }
}

export const scannerPatternRoutes: FastifyPluginAsync = fp(async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/admin/scanner-patterns
  app.get('/scanner-patterns', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const patterns = await fastify.prisma.scannerPattern.findMany({
      orderBy: [{ type: 'asc' }, { label: 'asc' }],
    });
    return { data: patterns };
  });

  // POST /api/v1/admin/scanner-patterns
  app.post(
    '/scanner-patterns',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: CreatePatternSchema },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { label, pattern, flags, type } = request.body;

      const regexError = validateRegex(pattern, flags);
      if (regexError) {
        return reply.status(400).send({ error: { code: 'INVALID_REGEX', message: regexError } });
      }

      const created = await fastify.prisma.scannerPattern.create({
        data: { flags, isBuiltIn: false, label, pattern, type },
      });
      invalidateScannerPatternCache();
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: { flags, label, pattern, type },
        entityId: created.id,
        entityType: 'ScannerPattern',
      });
      return reply.status(201).send({ data: created });
    }
  );

  // PUT /api/v1/admin/scanner-patterns/:id
  app.put(
    '/scanner-patterns/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: UpdatePatternSchema, params: PatternIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.scannerPattern.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Scanner pattern not found' } });
      }

      const { label, pattern, flags, type, isActive } = request.body;

      // Built-in patterns: only allow toggling isActive
      const updateData = existing.isBuiltIn
        ? { isActive: isActive ?? existing.isActive }
        : {
            flags: flags ?? existing.flags,
            isActive: isActive ?? existing.isActive,
            label: label ?? existing.label,
            pattern: pattern ?? existing.pattern,
            type: type ?? existing.type,
          };

      if (!existing.isBuiltIn && (pattern !== undefined || flags !== undefined)) {
        const regexError = validateRegex(pattern ?? existing.pattern, flags ?? existing.flags);
        if (regexError) {
          return reply.status(400).send({ error: { code: 'INVALID_REGEX', message: regexError } });
        }
      }

      const updated = await fastify.prisma.scannerPattern.update({
        data: updateData,
        where: { id: request.params.id },
      });
      invalidateScannerPatternCache();
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: updateData,
        before: {
          flags: existing.flags,
          isActive: existing.isActive,
          label: existing.label,
          pattern: existing.pattern,
          type: existing.type,
        },
        entityId: existing.id,
        entityType: 'ScannerPattern',
      });
      return { data: updated };
    }
  );

  // DELETE /api/v1/admin/scanner-patterns/:id
  app.delete(
    '/scanner-patterns/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: PatternIdParams },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const existing = await fastify.prisma.scannerPattern.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Scanner pattern not found' } });
      }
      if (existing.isBuiltIn) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Scanner pattern not found' } });
      }
      await fastify.prisma.scannerPattern.delete({ where: { id: request.params.id } });
      invalidateScannerPatternCache();
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        before: {
          flags: existing.flags,
          label: existing.label,
          pattern: existing.pattern,
          type: existing.type,
        },
        entityId: existing.id,
        entityType: 'ScannerPattern',
      });
      return reply.status(204).send();
    }
  );
});
