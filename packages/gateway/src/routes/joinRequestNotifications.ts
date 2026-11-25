/**
 * Admin view of the join-request notification outbox
 * (`docs/specs/2026-11-24-team-join-requests-hardening.md` §5).
 *
 * Platform admins list the rows (newest first) and re-queue a `FAILED` one. A row carries its
 * status, attempts, next attempt time and a fixed-shape error code; it never carries a recipient
 * address, a message body or a credential, and the `reached` record of who was already emailed is
 * not exposed at all.
 */
import {
  JOIN_REQUEST_NOTIFICATION_STATUSES,
  retryReset,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ListQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(JOIN_REQUEST_NOTIFICATION_STATUSES).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const CURSOR_ID = z.string().uuid();

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

/** The id half must be a UUID: it is compared with a `@db.Uuid` column, where text is a 500. */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso ?? '');
    return id && CURSOR_ID.safeParse(id).success && !Number.isNaN(createdAt.getTime())
      ? { createdAt, id }
      : null;
  } catch {
    return null;
  }
}

const VIEW_SELECT = {
  attempts: true,
  audience: true,
  channel: true,
  createdAt: true,
  deliveredAt: true,
  event: true,
  id: true,
  lastError: true,
  nextAttemptAt: true,
  request: { select: { id: true, team: { select: { id: true, name: true } } } },
  requestId: true,
  status: true,
  updatedAt: true,
} as const;

interface ViewRow {
  attempts: number;
  audience: string;
  channel: string;
  createdAt: Date;
  deliveredAt: Date | null;
  event: string;
  id: string;
  lastError: string | null;
  nextAttemptAt: Date;
  request: { team: { id: string; name: string } };
  requestId: string;
  status: string;
  updatedAt: Date;
}

/** One row as the admin sees it. Deliberately lists fields: `reached` is never one of them. */
function view(row: ViewRow) {
  return {
    attempts: row.attempts,
    audience: row.audience,
    channel: row.channel,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    event: row.event,
    id: row.id,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    requestId: row.requestId,
    status: row.status,
    teamId: row.request.team.id,
    teamName: row.request.team.name,
    updatedAt: row.updatedAt,
  };
}

export const joinRequestNotificationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ capability: 'platform.join-request-notifications.manage' });

  // GET /join-request-notifications?status=&limit=&cursor=
  app.get(
    '/join-request-notifications',
    { onRequest: adminOnly, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const { cursor, limit, status } = request.query;
      const after = cursor ? decodeCursor(cursor) : undefined;
      if (cursor && !after) {
        return sendError(reply, 400, 'INVALID_CURSOR', 'The cursor is not valid');
      }
      const rows = await runUnscoped(
        'a platform admin lists join-request notifications with their team names',
        ['TeamJoinRequest', 'Team'],
        () =>
          fastify.prisma.joinRequestNotification.findMany({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: VIEW_SELECT,
            take: limit + 1,
            where: {
              ...(status ? { status } : {}),
              ...(after
                ? {
                    OR: [
                      { createdAt: { lt: after.createdAt } },
                      { createdAt: after.createdAt, id: { lt: after.id } },
                    ],
                  }
                : {}),
            },
          })
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(view),
        meta: { nextCursor: rows.length > limit && last ? encodeCursor(last) : null },
      };
    }
  );

  // POST /join-request-notifications/:id/retry: re-queue a FAILED row, due now.
  app.post(
    '/join-request-notifications/:id/retry',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const actor = requireUser(request);
      const { id } = request.params;
      const now = new Date();
      // One transaction: the re-queue and its audit entry commit together, so an audit failure
      // re-queues nothing. The conditional update is the whole guard: only a row still `FAILED`
      // is re-queued, so two admins cannot both reset it and a delivered row is never sent again.
      const outcome = await fastify.prisma.$transaction(async (tx) => {
        const claim = await tx.joinRequestNotification.updateMany({
          data: retryReset(now),
          where: { id, status: 'FAILED' },
        });
        const row = await runUnscoped(
          'a platform admin reads one join-request notification with its team name',
          ['TeamJoinRequest', 'Team'],
          () => tx.joinRequestNotification.findUnique({ select: VIEW_SELECT, where: { id } })
        );
        if (!row) {
          return 'missing' as const;
        }
        if (claim.count !== 1) {
          return 'not_failed' as const;
        }
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor,
          after: { requeued: true, status: 'PENDING' },
          before: { status: 'FAILED' },
          client: tx,
          entityId: id,
          entityType: 'JoinRequestNotification',
        });
        return row;
      });
      if (outcome === 'missing') {
        return sendError(reply, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
      }
      if (outcome === 'not_failed') {
        return sendError(
          reply,
          409,
          'NOTIFICATION_NOT_FAILED',
          'Only a failed notification can be retried'
        );
      }
      return { data: view(outcome) };
    }
  );
};
