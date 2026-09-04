import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { invalidateSessionCache, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Platform-admin routes.
 *
 * All routes here require role ADMIN. They operate across users and are
 * intentionally not exposed in the self-service token/team routes.
 *
 *   GET    /api/v1/platform/access-tokens          — list all users' PATs
 *   DELETE /api/v1/platform/access-tokens/:id      — revoke any PAT
 *   GET    /api/v1/platform/sessions               — list active browser sessions
 *   DELETE /api/v1/platform/sessions/:id           — revoke a session
 *   GET    /api/v1/platform/audit-log               — recent config-audit rows
 *   POST   /api/v1/platform/shell-audit/prune      — delete old WorkflowShellAudit rows
 */

const TokenIdParam = z.object({ id: z.string().uuid() });
const SessionIdParam = z.object({ id: z.string().uuid() });
const PruneQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});
const AuditJsonSchema = z.json();
const AuditLogResponseSchema = z.object({
  data: z.array(
    z.object({
      action: z.string(),
      actorId: z.string().nullable(),
      afterJson: AuditJsonSchema.nullable().optional(),
      beforeJson: AuditJsonSchema.nullable().optional(),
      createdAt: z.string(),
      entityId: z.string().optional(),
      entityType: z.string(),
      id: z.string(),
    })
  ),
});

/// Auditable subset of a personal access token row. Never includes the plaintext
/// token or the stored sha-256 hash.
function safePatAuditFields(row: {
  expiresAt?: Date | null;
  id: string;
  name: string;
  prefix: string;
  revokedAt?: Date | null;
  userId: string;
}): Record<string, unknown> {
  return {
    expiresAt: row.expiresAt ?? null,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    revokedAt: row.revokedAt ?? null,
    userId: row.userId,
  };
}

/// Auditable subset of a browser session row. The full session token is a bearer
/// secret, so it is never placed in the audit log.
function safeSessionAuditFields(row: {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipAddress: string | null;
  updatedAt: Date;
  userAgent: string | null;
  userId: string;
}): Record<string, unknown> {
  return {
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    ipAddress: row.ipAddress,
    updatedAt: row.updatedAt,
    userAgent: row.userAgent,
    userId: row.userId,
  };
}

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
      const actor = requireUser(request);
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: safePatAuditFields({
          expiresAt: updated.expiresAt,
          id: updated.id,
          name: updated.name,
          prefix: updated.prefix,
          revokedAt: updated.revokedAt,
          userId: updated.userId,
        }),
        before: safePatAuditFields({
          expiresAt: existing.expiresAt,
          id: existing.id,
          name: existing.name,
          prefix: existing.prefix,
          revokedAt: existing.revokedAt,
          userId: existing.userId,
        }),
        entityId: updated.id,
        entityType: 'PersonalAccessToken',
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
      const before = safeSessionAuditFields(existing);
      await fastify.prisma.session.delete({ where: { id: existing.id } });
      // Also drop the in-memory cache entry so the revoked session can't
      // satisfy another /api/v1/* call within the 60s TTL window.
      invalidateSessionCache(existing.token);
      const actor = requireUser(request);
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor,
        after: { revoked: true },
        before,
        entityId: existing.id,
        entityType: 'Session',
      });
      return { data: { id: existing.id, revoked: true } };
    }
  );

  // ── Audit log ─────────────────────────────────────────────────────────────

  app.get(
    '/audit-log',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { response: { 200: AuditLogResponseSchema } },
    },
    async () => {
      const rows = await fastify.prisma.configAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return {
        data: rows.map((row) => ({
          ...row,
          afterJson: row.afterJson as z.infer<typeof AuditJsonSchema> | null,
          beforeJson: row.beforeJson as z.infer<typeof AuditJsonSchema> | null,
          createdAt: row.createdAt.toISOString(),
        })),
      };
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
      // Retention applies to the whole table; pruning per tenant would leave
      // other teams' audit rows growing forever.
      const { count } = await runUnscoped(
        'audit retention sweep is table-wide',
        ['WorkflowShellAudit'],
        () => fastify.prisma.workflowShellAudit.deleteMany({ where: { createdAt: { lt: cutoff } } })
      );
      return { data: { deleted: count, olderThanDays: request.query.days } };
    }
  );
};
