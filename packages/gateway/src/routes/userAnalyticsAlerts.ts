import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import type { FastifyPluginAsync } from 'fastify';
import { ACTOR_EVENTS_PER_MINUTE } from '../lib/activityEvents.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * `GET /api/v1/platform/analytics/alerts` (ADMIN): accounts with at least `threshold` failed
 * sign-ins inside the last `windowMinutes`.
 *
 * Cost per uncached request, all on the `(kind, createdAt)` and `(actorId, createdAt)` indexes:
 * one `groupBy` on actorId with a `having` count, `take` 51; then, for at most 50 accounts, one
 * `findMany` of failure methods (take 2000), one `groupBy` of later sign-ins, one user lookup.
 * Cached for CACHE_TTL_MS, so a polling dashboard costs the same as one visitor.
 */
const MAX_ALERTS = 50;
const METHOD_ROW_CAP = 2000;
const CACHE_TTL_MS = 10_000;

function method(props: unknown): string {
  const v = props && typeof props === 'object' ? (props as Record<string, unknown>).method : null;
  return typeof v === 'string' && v ? v : 'unknown';
}

export async function buildAlerts(prisma: PrismaClient, now = new Date()) {
  const [threshold, windowMinutes] = await Promise.all([
    resolveSetting('analytics.failedSignInAlertThreshold', {}),
    resolveSetting('analytics.failedSignInAlertWindowMinutes', {}),
  ]);
  const since = new Date(now.getTime() - windowMinutes * 60_000);
  const groups = await prisma.userActivityEvent.groupBy({
    _count: { _all: true },
    _max: { createdAt: true },
    _min: { createdAt: true },
    by: ['actorId'],
    having: { actorId: { _count: { gte: threshold } } },
    orderBy: { _count: { actorId: 'desc' } },
    take: MAX_ALERTS + 1,
    where: { actorId: { not: null }, createdAt: { gte: since }, kind: 'sign_in_failed' },
  });
  const truncated = groups.length > MAX_ALERTS;
  const top = groups
    .slice(0, MAX_ALERTS)
    .flatMap((g) => (g.actorId ? [{ ...g, id: g.actorId }] : []));
  const ids = top.map((g) => g.id);
  // The per-actor bucket caps how many failures are recorded per account, so a threshold above
  // this can never be reached however hard the account is guessed at.
  const perMinute = ACTOR_EVENTS_PER_MINUTE.sign_in_failed;
  const maxRecordable = Math.floor(perMinute * windowMinutes) + perMinute;
  const base = {
    failuresRecordedPerMinute: perMinute,
    generatedAt: now.toISOString(),
    maxRecordable,
    threshold,
    thresholdReachable: threshold <= maxRecordable,
    truncated,
    windowMinutes,
  };
  if (ids.length === 0) {
    return { ...base, alerts: [] };
  }
  const [methodRows, signIns, users] = await Promise.all([
    prisma.userActivityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      select: { actorId: true, props: true },
      take: METHOD_ROW_CAP,
      where: { actorId: { in: ids }, createdAt: { gte: since }, kind: 'sign_in_failed' },
    }),
    prisma.userActivityEvent.groupBy({
      _max: { createdAt: true },
      by: ['actorId'],
      where: { actorId: { in: ids }, createdAt: { gte: since }, kind: 'sign_in' },
    }),
    prisma.user.findMany({
      select: { email: true, id: true, name: true },
      where: { id: { in: ids } },
    }),
  ]);
  const methods = new Map<string, Set<string>>();
  for (const r of methodRows) {
    if (r.actorId) {
      const set = methods.get(r.actorId) ?? new Set<string>();
      set.add(method(r.props));
      methods.set(r.actorId, set);
    }
  }
  const lastSignIn = new Map(
    signIns.flatMap((r) => (r.actorId && r._max.createdAt ? [[r.actorId, r._max.createdAt]] : []))
  );
  const userById = new Map(users.map((u) => [u.id, u]));
  const alerts = top
    .map((g) => {
      const firstAt = g._min.createdAt;
      const lastAt = g._max.createdAt;
      const ok = lastSignIn.get(g.id);
      return {
        email: userById.get(g.id)?.email ?? null,
        failures: g._count._all,
        firstAt: firstAt ? firstAt.toISOString() : null,
        lastAt: lastAt ? lastAt.toISOString() : null,
        methods: [...(methods.get(g.id) ?? [])].sort(),
        name: userById.get(g.id)?.name ?? null,
        signedInAfter: Boolean(ok && firstAt && ok.getTime() > firstAt.getTime()),
        userId: g.id,
      };
    })
    .sort((a, b) => b.failures - a.failures || a.userId.localeCompare(b.userId));
  return { ...base, alerts };
}

export const userAnalyticsAlertsRoutes: FastifyPluginAsync = async (app) => {
  const { prisma } = app;
  let cache: { at: number; value: Promise<unknown> } | undefined;

  app.get(
    '/analytics/alerts',
    { onRequest: requireAuth({ capability: 'platform.audit.read' }) },
    async () => {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.value;
      }
      const entry = { at: Date.now(), value: buildAlerts(prisma) as Promise<unknown> };
      cache = entry;
      entry.value.catch(() => {
        if (cache === entry) {
          cache = undefined;
        }
      });
      return entry.value;
    }
  );
};
