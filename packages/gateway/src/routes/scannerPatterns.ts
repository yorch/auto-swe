import {
  checkRegexSafety,
  MAX_PATTERN_SOURCE_LENGTH,
  type RegexSafetyIssue,
} from '@auto-swe/shared/lib/regexSafety';
import { invalidateScannerPatternCache } from '@auto-swe/shared/lib/skillScanner';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const PATTERN_TYPES = [
  'INJECTION',
  'EXFILTRATION',
  'SHELL_COMMAND',
  'CODE_SECURITY',
  'SENSITIVE_FILE',
] as const;

const PatternIdParams = z.object({ id: z.string().uuid() });

const SAFE_FLAGS_RE = /^[imsuv]*$/;
const safeFlags = z
  .string()
  .max(10)
  .refine((f) => SAFE_FLAGS_RE.test(f), {
    message: "flags may only contain i, m, s, u, v — 'g' and 'y' are not allowed",
  });

const CreatePatternSchema = z.object({
  flags: safeFlags.default(''),
  label: z.string().min(1).max(200),
  pattern: z.string().min(1).max(MAX_PATTERN_SOURCE_LENGTH),
  type: z.enum(PATTERN_TYPES),
});

const UpdatePatternSchema = z.object({
  flags: safeFlags.optional(),
  isActive: z.boolean().optional(),
  label: z.string().min(1).max(200).optional(),
  pattern: z.string().min(1).max(MAX_PATTERN_SOURCE_LENGTH).optional(),
  type: z.enum(PATTERN_TYPES).optional(),
});

/**
 * Reject a pattern that will not compile OR that admits catastrophic
 * backtracking. Compiling was never enough: every stored pattern is later run
 * in-process against unbounded agent text, and JS regex execution cannot be
 * interrupted, so `(a+)+$` saved here is a denial of service on the worker.
 * Shared with bundle install (`validateBundleScannerPatterns`) so neither entry
 * point can be used to get around the other.
 */
function validateRegex(pattern: string, flags: string): RegexSafetyIssue | null {
  // The error code doubles as the API's `error.code`: `INVALID_REGEX` stays what
  // it always was for a compile failure; a rejected-as-unsafe pattern reports
  // `REDOS_RISK` so a client can tell the two apart.
  return checkRegexSafety(pattern, flags);
}

export const scannerPatternRoutes: FastifyPluginAsync = async (fastify) => {
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
        return reply.status(400).send({ error: regexError });
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
          return reply.status(400).send({ error: regexError });
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
        return reply.status(403).send({
          error: {
            code: 'BUILTIN_PATTERN',
            message: 'Built-in scanner patterns cannot be deleted',
          },
        });
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
};
