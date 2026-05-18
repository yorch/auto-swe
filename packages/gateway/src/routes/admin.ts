import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { invalidateSessionCache, requireAuth } from '../plugins/auth.js';

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
const SessionIdParam = z.object({ id: z.string().uuid() });
const PruneQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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

  app.delete(
    '/access-tokens/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TokenIdParam },
    },
    async (request, reply) => {
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

  // ── Better-auth session admin — list / revoke browser sessions ──

  app.get('/sessions', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async () => {
    const rows = await fastify.prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        ipAddress: true,
        token: true,
        updatedAt: true,
        user: { select: { email: true, id: true } },
        userAgent: true,
      },
    });
    // Truncate the token to a prefix in the response — admins shouldn't be
    // able to read full bearer values out of the dashboard.
    return {
      data: rows.map((r) => ({
        ...r,
        token: `${r.token.slice(0, 8)}…`,
      })),
    };
  });

  app.delete(
    '/sessions/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: SessionIdParam },
    },
    async (request, reply) => {
      const existing = await fastify.prisma.session.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
        });
      }
      await fastify.prisma.session.delete({ where: { id: existing.id } });
      // Also drop the in-memory cache entry so the revoked session can't
      // satisfy another /api/v1/* call within the 60s TTL window.
      invalidateSessionCache(existing.token);
      return { data: { id: existing.id, revoked: true } };
    }
  );

  // Intended for cron use; returns count so callers can alert on anomalies.
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
