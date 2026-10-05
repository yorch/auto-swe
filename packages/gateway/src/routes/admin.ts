import { Readable } from 'node:stream';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { paginationQuery } from '../lib/pagination.js';
import { safePatAuditFields } from '../lib/patAuditFields.js';
import {
  extractSessionCookieValue,
  invalidateSessionCache,
  requireAuth,
  requireUser,
} from '../plugins/auth.js';

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
 *   POST   /api/v1/platform/sessions/revoke-user   — revoke every session of one user (not the caller's own)
 *   GET    /api/v1/platform/audit-log               — config-audit rows, filtered + paginated
 *   POST   /api/v1/platform/shell-audit/prune      — delete old WorkflowShellAudit rows
 */

const TokenIdParam = z.object({ id: z.string().uuid() });
const SessionIdParam = z.object({ id: z.string().uuid() });
const RevokeUserBody = z.object({ userId: z.string().uuid() });
const PruneQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});
const DAY_MS = 24 * 60 * 60 * 1000;
const AuditLogQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend({
  action: z.enum(['CREATE', 'DELETE', 'UPDATE']).optional(),
  actorId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(100).optional(),
  /** Free text over the actor's email or name, the entity type and the entity id. */
  search: z.string().trim().min(1).max(100).optional(),
  /** Inclusive UTC calendar days, `YYYY-MM-DD` — what a date input produces. */
  since: z.iso.date().optional(),
  until: z.iso.date().optional(),
});
/** The export takes the same filters as the list, without a page window. */
const AuditLogExportQuery = AuditLogQuery.omit({ limit: true, offset: true });
/** An export is a file for a person, not a backup: it stops here and says so in a header. */
const AUDIT_EXPORT_MAX_ROWS = 50_000;
const AUDIT_EXPORT_BATCH = 500;

/** A CSV cell. A leading `= + - @` would run as a formula in a spreadsheet, so it is defused. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const AuditJsonSchema = z.json();
const AuditLogResponseSchema = z.object({
  data: z.array(
    z.object({
      action: z.string(),
      actor: z.object({ email: z.string(), name: z.string().nullable() }).nullable(),
      actorId: z.string().nullable(),
      afterJson: AuditJsonSchema.nullable().optional(),
      beforeJson: AuditJsonSchema.nullable().optional(),
      createdAt: z.string(),
      entityId: z.string().optional(),
      entityType: z.string(),
      id: z.string(),
    })
  ),
  meta: z.object({
    /** Every entity type the log holds, for the filter control. */
    entityTypes: z.array(z.string()),
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
  }),
});

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

  /// The unsigned session token the caller's own browser cookie carries (`<token>.<signature>`),
  /// or null when the caller authenticated some other way (a token, an API client).
  const callerSessionToken = (headers: Parameters<typeof extractSessionCookieValue>[0]) =>
    extractSessionCookieValue(headers)?.split('.')[0] ?? null;

  app.get('/sessions', { onRequest: requireAuth({ requiredRole: 'ADMIN' }) }, async (request) => {
    const own = callerSessionToken(request.headers);
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
        // Lets the list mark the caller's own session, which they should not revoke blind.
        current: own !== null && r.token === own,
        token: `${r.token.slice(0, 8)}…`,
      })),
    };
  });

  // Signs one user out everywhere. The caller's own session survives, so an admin
  // clearing their own sessions is not logged out of the page they are using.
  app.post(
    '/sessions/revoke-user',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: RevokeUserBody },
    },
    async (request) => {
      const own = callerSessionToken(request.headers);
      const sessions = await fastify.prisma.session.findMany({
        where: { userId: request.body.userId },
      });
      const actor = requireUser(request);
      let revoked = 0;
      for (const existing of sessions) {
        if (own !== null && existing.token === own) {
          continue;
        }
        const before = safeSessionAuditFields(existing);
        await fastify.prisma.session.delete({ where: { id: existing.id } });
        invalidateSessionCache(existing.token);
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor,
          after: { revoked: true },
          before,
          entityId: existing.id,
          entityType: 'Session',
        });
        revoked += 1;
      }
      return { data: { revoked } };
    }
  );

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

  /** One filter for the list and the export, so a file always matches what was on screen. */
  async function auditWhere(q: z.infer<typeof AuditLogExportQuery>) {
    const { action, actorId, entityType, search, since, until } = q;
    const createdAt = {
      ...(since ? { gte: new Date(`${since}T00:00:00.000Z`) } : {}),
      // `until` names a whole day, so the bound is the start of the next one.
      ...(until ? { lt: new Date(Date.parse(`${until}T00:00:00.000Z`) + DAY_MS) } : {}),
    };
    let searchClause = {};
    if (search) {
      // The log has no relation to User, so an actor match is a lookup of their ids.
      const people = await fastify.prisma.user.findMany({
        select: { id: true },
        take: 200,
        where: {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        },
      });
      searchClause = {
        OR: [
          { entityId: { contains: search, mode: 'insensitive' } },
          { entityType: { contains: search, mode: 'insensitive' } },
          ...(people.length ? [{ actorId: { in: people.map((u) => u.id) } }] : []),
        ],
      };
    }
    return {
      ...(action ? { action } : {}),
      ...(actorId ? { actorId } : {}),
      ...(entityType ? { entityType } : {}),
      ...(since || until ? { createdAt } : {}),
      ...searchClause,
    };
  }

  // The current filter as a CSV file. Rows are the stored ones, which never hold
  // secret values or credential hashes, so nothing is redacted here that the list
  // would not also show.
  app.get(
    '/audit-log/export',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: AuditLogExportQuery },
    },
    async (request, reply) => {
      const where = await auditWhere(request.query);
      // Known before streaming starts, so the header can say the file is cut short.
      const matching = await fastify.prisma.configAuditLog.count({ where });
      async function* lines() {
        yield 'time,action,actor,entity_type,entity_id,before,after\n';
        let cursor: string | undefined;
        let written = 0;
        while (written < AUDIT_EXPORT_MAX_ROWS) {
          const rows = await fastify.prisma.configAuditLog.findMany({
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: AUDIT_EXPORT_BATCH,
            where,
          });
          if (rows.length === 0) {
            return;
          }
          const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
          const actors = actorIds.length
            ? await fastify.prisma.user.findMany({
                select: { email: true, id: true },
                where: { id: { in: actorIds } },
              })
            : [];
          const emailById = new Map(actors.map((a) => [a.id, a.email]));
          for (const r of rows) {
            yield `${[
              r.createdAt.toISOString(),
              r.action,
              r.actorId ? (emailById.get(r.actorId) ?? r.actorId) : 'system',
              r.entityType,
              r.entityId,
              r.beforeJson,
              r.afterJson,
            ]
              .map(csvCell)
              .join(',')}\n`;
          }
          written += rows.length;
          cursor = rows[rows.length - 1]?.id;
          if (rows.length < AUDIT_EXPORT_BATCH) {
            return;
          }
        }
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="audit-log.csv"')
        .header('X-Export-Row-Limit', String(AUDIT_EXPORT_MAX_ROWS))
        .header('X-Export-Truncated', String(matching > AUDIT_EXPORT_MAX_ROWS))
        .send(Readable.from(lines()));
    }
  );

  app.get(
    '/audit-log',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: AuditLogQuery, response: { 200: AuditLogResponseSchema } },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const where = await auditWhere(request.query);
      const [rows, total, entityTypeGroups] = await Promise.all([
        fastify.prisma.configAuditLog.findMany({
          // `id` breaks ties: rows written together share `createdAt`, and an
          // offset page boundary inside a tie would repeat or skip rows.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.configAuditLog.count({ where }),
        fastify.prisma.configAuditLog.groupBy({
          by: ['entityType'],
          orderBy: { entityType: 'asc' },
        }),
      ]);
      // A second lookup rather than a relation: the log has no foreign key to
      // User, so a deleted actor's rows keep their id and render without an email.
      const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
      const actors = actorIds.length
        ? await fastify.prisma.user.findMany({
            select: { email: true, id: true, name: true },
            where: { id: { in: actorIds } },
          })
        : [];
      const actorById = new Map(actors.map((a) => [a.id, { email: a.email, name: a.name }]));
      return {
        data: rows.map((row) => ({
          ...row,
          actor: row.actorId ? (actorById.get(row.actorId) ?? null) : null,
          afterJson: row.afterJson as z.infer<typeof AuditJsonSchema> | null,
          beforeJson: row.beforeJson as z.infer<typeof AuditJsonSchema> | null,
          createdAt: row.createdAt.toISOString(),
        })),
        meta: {
          entityTypes: entityTypeGroups.map((g) => g.entityType),
          limit,
          offset,
          total,
        },
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
