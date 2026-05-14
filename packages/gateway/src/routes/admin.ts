import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Platform-admin routes.
 *
 * All routes here require role ADMIN. They operate across users and are
 * intentionally not exposed in the self-service token/team routes.
 *
 *   GET    /api/v1/admin/access-tokens          — list all users' PATs
 *   DELETE /api/v1/admin/access-tokens/:id      — revoke any PAT
 *   POST   /api/v1/admin/shell-audit/prune      — delete old WorkflowShellAudit rows
 */

const TokenIdParam = z.object({ id: z.string().uuid() });
const PruneQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── List all PATs across all users ──
  app.get('/access-tokens', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const rows = await fastify.prisma.personalAccessToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        lastUsedAt: true,
        name: true,
        prefix: true,
        revokedAt: true,
        user: { select: { email: true, id: true } },
      },
    });
    return { data: rows };
  });

  // ── Revoke any PAT by ID ──
  app.delete(
    '/access-tokens/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TokenIdParam },
    },
    async (request, reply) => {
      requireUser(request);
      const existing = await fastify.prisma.personalAccessToken.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'TOKEN_NOT_FOUND', message: 'Token not found' },
        });
      }
      if (existing.revokedAt) {
        return { data: { id: existing.id, revokedAt: existing.revokedAt } };
      }
      const updated = await fastify.prisma.personalAccessToken.update({
        data: { revokedAt: new Date() },
        where: { id: existing.id },
      });
      return { data: { id: updated.id, revokedAt: updated.revokedAt } };
    }
  );

  // ── Prune old shell-audit rows ──
  // Intended to be called from a cron job (e.g. daily at midnight).
  // Returns the number of deleted rows so the caller can log/alert on anomalies.
  app.post(
    '/shell-audit/prune',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: PruneQuery },
    },
    async (request) => {
      const cutoff = new Date(Date.now() - request.query.days * 24 * 60 * 60 * 1000);
      const { count } = await fastify.prisma.workflowShellAudit.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      return { data: { deleted: count, olderThanDays: request.query.days } };
    }
  );
};
