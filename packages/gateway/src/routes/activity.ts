import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UI_DEDUPE_MS } from '../lib/activityEvents.js';
import { auditContextOf } from '../lib/auditContext.js';
import { mapLimited } from '../lib/mapLimited.js';
import { paginationQuery } from '../lib/pagination.js';
import { uiRouteTemplate } from '../lib/uiRoutes.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/**
 * First-party activity events (docs/user-activity.md).
 *
 *   POST /api/v1/activity/ui                  — the dashboard's page views (opt-in, authenticated)
 *   GET  /api/v1/platform/activity            — recorded events, filtered and paginated (ADMIN)
 *   GET  /api/v1/platform/activity/summary    — counts by kind and day, top denied routes (ADMIN)
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Concurrent per-day count queries; the connection pool is small (same cap as the usage route). */
const DAILY_CONCURRENCY = 3;

const UiEventsBody = z.object({
  events: z
    .array(z.object({ event: z.literal('page_view'), route: z.string().max(300) }))
    .min(1)
    .max(20),
});

const KINDS = ['denied', 'read', 'export', 'ui'] as const;
const ActivityQuery = paginationQuery({ defaultLimit: 50, maxLimit: 200 }).extend({
  actorId: z.string().uuid().optional(),
  kind: z.enum(KINDS).optional(),
  route: z.string().min(1).max(300).optional(),
  /** Inclusive UTC calendar days, `YYYY-MM-DD`. */
  since: z.iso.date().optional(),
  until: z.iso.date().optional(),
});
const SummaryQuery = z.object({ days: z.coerce.number().int().min(1).max(30).default(14) });

/** Page views from the dashboard. Authenticated, and a no-op unless an operator turned it on. */
export const activityUiRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.post('/ui', { onRequest: requireAuth(), schema: { body: UiEventsBody } }, async (request) => {
    const user = requireUser(request);
    // Read per request: the switch needs no restart, and the client stops sending on `false`.
    if (!(await resolveSetting('analytics.uiEventsEnabled', {}))) {
      return { accepted: 0, enabled: false };
    }
    const context = auditContextOf(request);
    let accepted = 0;
    for (const { route } of request.body.events) {
      // A path the allowlist does not know (an id-bearing unknown page, a query string) is
      // dropped, not trimmed.
      const template = uiRouteTemplate(route);
      if (!template) {
        continue;
      }
      // The same page from the same person within a few seconds is one view, in this batch or
      // the next; a view that is dropped does not count as seen.
      const queued = fastify.activityQueue.enqueue(
        {
          actorId: user.sub,
          ip: context.ip ?? null,
          kind: 'ui',
          method: 'VIEW',
          props: { event: 'page_view' },
          requestId: context.requestId ?? null,
          route: template,
          status: null,
          via: context.via ?? null,
        },
        { key: `ui|${user.sub}|${template}`, ttlMs: UI_DEDUPE_MS }
      );
      if (queued) {
        accepted += 1;
      }
    }
    return { accepted, enabled: true };
  });
};

/** The ADMIN view of what was recorded. */
export const activityAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/activity',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }), schema: { querystring: ActivityQuery } },
    async (request) => {
      const { actorId, kind, limit, offset, route, since, until } = request.query;
      const where: Prisma.UserActivityEventWhereInput = {
        ...(actorId ? { actorId } : {}),
        ...(kind ? { kind } : {}),
        ...(route ? { route } : {}),
        ...(since || until
          ? {
              createdAt: {
                ...(since ? { gte: new Date(`${since}T00:00:00.000Z`) } : {}),
                ...(until ? { lt: new Date(Date.parse(`${until}T00:00:00.000Z`) + DAY_MS) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.userActivityEvent.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.userActivityEvent.count({ where }),
      ]);
      // The table has no relation to User (a row outlives the person), so names are a second lookup.
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
          createdAt: row.createdAt.toISOString(),
        })),
        meta: { limit, offset, total },
      };
    }
  );

  app.get(
    '/activity/summary',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }), schema: { querystring: SummaryQuery } },
    async (request) => {
      const { days } = request.query;
      // One indexed `groupBy` per UTC day (at most 30) instead of reading rows back and counting
      // them here: exact, and the cost does not grow with the number of events.
      const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const dayStarts = Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY_MS);
      const since = new Date(dayStarts[0] ?? today);
      // At most DAILY_CONCURRENCY queries at once, the pool being small; the rest follow in turn.
      const perDay = await mapLimited(dayStarts, DAILY_CONCURRENCY, (start) =>
        fastify.prisma.userActivityEvent.groupBy({
          _count: { _all: true },
          by: ['kind'],
          where: { createdAt: { gte: new Date(start), lt: new Date(start + DAY_MS) } },
        })
      );
      const topDenied = await fastify.prisma.userActivityEvent.groupBy({
        _count: { _all: true },
        by: ['route'],
        orderBy: { _count: { route: 'desc' } },
        take: 10,
        where: { createdAt: { gte: since }, kind: 'denied' },
      });
      const retentionDays = await resolveSetting('analytics.activityRetentionDays', {});
      const uiEventsEnabled = await resolveSetting('analytics.uiEventsEnabled', {});
      const totals = { denied: 0, export: 0, read: 0, ui: 0 };
      const daily = dayStarts.flatMap((start, i) => {
        const counts = { denied: 0, export: 0, read: 0, ui: 0 };
        for (const group of perDay[i] ?? []) {
          if (group.kind in counts) {
            const k = group.kind as (typeof KINDS)[number];
            counts[k] = group._count._all;
            totals[k] += group._count._all;
          }
        }
        const any = KINDS.some((k) => counts[k] > 0);
        return any ? [{ day: new Date(start).toISOString().slice(0, 10), ...counts }] : [];
      });
      return {
        daily,
        days,
        // Events this gateway process dropped since it started (queue full, rate-limited or a
        // failed write).
        dropped: fastify.activityQueue.dropped,
        retentionDays,
        topDenied: topDenied.map((r) => ({ count: r._count._all, route: r.route })),
        totals,
        uiEventsEnabled,
      };
    }
  );
};
