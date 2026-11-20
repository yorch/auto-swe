import type { PrismaClient } from '@auto-swe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { truncateIp } from '../lib/auditContext.js';
import { csvRow } from '../lib/csv.js';
import { sendError } from '../lib/httpErrors.js';
import { mapLimited } from '../lib/mapLimited.js';
import { parseUserAgent } from '../lib/userAgent.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Admin user analytics (docs/user-activity.md): sign-ins, active users and the actions people take,
 * read from the first-party `user_activity_events` and `config_audit_log` tables. All ADMIN-only.
 *
 *   GET /api/v1/platform/analytics/overview     — platform-wide tiles, per-day series, breakdowns
 *   GET /api/v1/platform/analytics/users        — one row per person, searchable and sortable
 *   GET /api/v1/platform/analytics/users/export — the same rows as a CSV file (a recorded export)
 *   GET /api/v1/platform/analytics/users/:id    — one person's detail (itself a recorded `read`)
 *
 * Cost: the per-day aggregates are one indexed `groupBy` per UTC day and source over a fixed
 * 30-day window (60 queries, three at a time), cached for CACHE_TTL_MS and shared by all three
 * routes, so a polling dashboard costs the same as one visitor. Rows are read back only where a
 * `groupBy` cannot answer (method/browser/hour breakdowns, histories), always capped, and the
 * response says `truncated: true` when a cap cut into the requested window.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_DAYS = 30;
const DAILY_CONCURRENCY = 3;
const CACHE_TTL_MS = 30_000;
const ROW_CAP = 5000;
const USER_CAP = 5000;
const HISTORY_LIMIT = 50;

/**
 * "Active on a day": the person has at least one of these events, or at least one audit-log row
 * as the actor that is not a `Session` row (a launch writes one, so launches count). One
 * definition, used by every count below.
 */
export const ACTIVE_USER_EVENT_KINDS = ['sign_in', 'ui', 'read', 'export'] as const;
const SIGN_KINDS = ['sign_in', 'sign_in_failed', 'sign_out'] as const;
const COUNTED_KINDS = [...SIGN_KINDS, 'ui', 'read', 'export'];
const ACTIONS = ['CREATE', 'UPDATE', 'DELETE'] as const;
type ActionName = (typeof ACTIONS)[number];

const DaysQuery = z.object({ days: z.coerce.number().int().min(1).max(SCAN_DAYS).default(14) });
const UsersQuery = DaysQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['lastActive', 'actions', 'signIns', 'failed', 'email']).default('lastActive'),
});
const ExportQuery = UsersQuery.omit({ limit: true, offset: true });
/** The people list's columns, in file order; a header is the field name. */
const EXPORT_COLUMNS = [
  'email',
  'name',
  'role',
  'userId',
  'createdAt',
  'lastActiveAt',
  'lastSignInAt',
  'signIns',
  'failedSignIns',
  'actions',
  'activeDays',
  'activeSessions',
] as const;
const IdParams = z.object({ id: z.string().uuid() });

interface ActorDay {
  signIns: number;
  failed: number;
  signOuts: number;
  actions: number;
  active: boolean;
  lastActive: number;
  lastSignIn: number;
}
interface DayAgg {
  day: string;
  actors: Map<string, ActorDay>;
  entity: Map<string, number>;
  action: Record<ActionName, number>;
}
interface Scan {
  days: DayAgg[];
  signRows: Array<{ kind: string; createdAt: Date; props: unknown }>;
  actionTimes: Date[];
  signRowsCapped: boolean;
  actionTimesCapped: boolean;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const iso = (d: Date | number | null | undefined) =>
  d === null || d === undefined || d === 0 ? null : new Date(d).toISOString();
const blankActor = (): ActorDay => ({
  actions: 0,
  active: false,
  failed: 0,
  lastActive: 0,
  lastSignIn: 0,
  signIns: 0,
  signOuts: 0,
});
const round1 = (n: number) => Math.round(n * 10) / 10;

function propString(props: unknown, key: string): string {
  const v = props && typeof props === 'object' ? (props as Record<string, unknown>)[key] : null;
  return typeof v === 'string' && v ? v : 'unknown';
}
function tally(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}
const toCounts = <K extends string>(map: Map<string, number>, name: K, limit?: number) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k, count]) => ({ [name]: k, count }) as { [P in K]: string } & { count: number });

async function scan(prisma: PrismaClient): Promise<Scan> {
  const today = startOfUtcDay(Date.now());
  const starts = Array.from({ length: SCAN_DAYS }, (_, i) => today - (SCAN_DAYS - 1 - i) * DAY_MS);
  const since = new Date(starts[0] ?? today);
  const days = await mapLimited(starts, DAILY_CONCURRENCY, async (start): Promise<DayAgg> => {
    const range = { gte: new Date(start), lt: new Date(start + DAY_MS) };
    const [events, audit] = await Promise.all([
      prisma.userActivityEvent.groupBy({
        _count: { _all: true },
        _max: { createdAt: true },
        by: ['actorId', 'kind'],
        where: { actorId: { not: null }, createdAt: range, kind: { in: COUNTED_KINDS } },
      }),
      prisma.configAuditLog.groupBy({
        _count: { _all: true },
        _max: { createdAt: true },
        by: ['actorId', 'entityType', 'action'],
        where: { actorId: { not: null }, createdAt: range, entityType: { not: 'Session' } },
      }),
    ]);
    const agg: DayAgg = {
      action: { CREATE: 0, DELETE: 0, UPDATE: 0 },
      actors: new Map(),
      day: dayKey(start),
      entity: new Map(),
    };
    const actor = (id: string) => {
      let a = agg.actors.get(id);
      if (!a) {
        a = blankActor();
        agg.actors.set(id, a);
      }
      return a;
    };
    for (const g of events) {
      if (!g.actorId) {
        continue;
      }
      const a = actor(g.actorId);
      const n = g._count._all;
      const at = g._max.createdAt?.getTime() ?? 0;
      if (g.kind === 'sign_in') {
        a.signIns += n;
        a.lastSignIn = Math.max(a.lastSignIn, at);
      } else if (g.kind === 'sign_in_failed') {
        a.failed += n;
      } else if (g.kind === 'sign_out') {
        a.signOuts += n;
      }
      if ((ACTIVE_USER_EVENT_KINDS as readonly string[]).includes(g.kind)) {
        a.active = true;
        a.lastActive = Math.max(a.lastActive, at);
      }
    }
    for (const g of audit) {
      if (!g.actorId) {
        continue;
      }
      const a = actor(g.actorId);
      const n = g._count._all;
      a.actions += n;
      a.active = true;
      a.lastActive = Math.max(a.lastActive, g._max.createdAt?.getTime() ?? 0);
      tally(agg.entity, g.entityType, n);
      agg.action[g.action as ActionName] += n;
    }
    return agg;
  });
  const [signRows, actionRows] = await Promise.all([
    prisma.userActivityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, kind: true, props: true },
      take: ROW_CAP,
      where: { createdAt: { gte: since }, kind: { in: ['sign_in', 'sign_in_failed'] } },
    }),
    prisma.configAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
      take: ROW_CAP,
      where: { actorId: { not: null }, createdAt: { gte: since }, entityType: { not: 'Session' } },
    }),
  ]);
  return {
    actionTimes: actionRows.map((r) => r.createdAt),
    actionTimesCapped: actionRows.length >= ROW_CAP,
    days,
    signRows,
    signRowsCapped: signRows.length >= ROW_CAP,
  };
}

/** The last `days` entries of a scan. */
const windowOf = (s: Scan, days: number) => s.days.slice(SCAN_DAYS - days);

/** Per-actor totals over some days. */
function sumByActor(days: DayAgg[]) {
  const out = new Map<
    string,
    {
      signIns: number;
      failed: number;
      actions: number;
      activeDays: number;
      lastActive: number;
      lastSignIn: number;
    }
  >();
  for (const d of days) {
    for (const [id, a] of d.actors) {
      const t = out.get(id) ?? {
        actions: 0,
        activeDays: 0,
        failed: 0,
        lastActive: 0,
        lastSignIn: 0,
        signIns: 0,
      };
      t.signIns += a.signIns;
      t.failed += a.failed;
      t.actions += a.actions;
      t.activeDays += a.active ? 1 : 0;
      t.lastActive = Math.max(t.lastActive, a.lastActive);
      t.lastSignIn = Math.max(t.lastSignIn, a.lastSignIn);
      out.set(id, t);
    }
  }
  return out;
}

function activeIds(days: DayAgg[]): Set<string> {
  const ids = new Set<string>();
  for (const d of days) {
    for (const [id, a] of d.actors) {
      if (a.active) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export const userAnalyticsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { prisma } = fastify;

  // Shared by the three routes; a rejected scan is not kept.
  let scanCache: { at: number; value: Promise<Scan> } | null = null;
  const getScan = (): Promise<Scan> => {
    if (scanCache && Date.now() - scanCache.at < CACHE_TTL_MS) {
      return scanCache.value;
    }
    const value = scan(prisma);
    const entry = { at: Date.now(), value };
    scanCache = entry;
    value.catch(() => {
      if (scanCache === entry) {
        scanCache = null;
      }
    });
    return value;
  };
  const overviewCache = new Map<number, { at: number; value: Promise<unknown> }>();

  async function buildOverview(days: number) {
    const s = await getScan();
    const win = windowOf(s, days);
    const today = Date.now();
    const windowStart = startOfUtcDay(today) - (days - 1) * DAY_MS;
    const now = new Date();

    const totalsByActor = sumByActor(win);
    let signIns = 0;
    let failed = 0;
    let actionTotal = 0;
    const entity = new Map<string, number>();
    const byAction = { CREATE: 0, DELETE: 0, UPDATE: 0 };
    const activeByDay = win.map((d) => {
      let si = 0;
      let fa = 0;
      let so = 0;
      let ac = 0;
      let active = 0;
      for (const a of d.actors.values()) {
        si += a.signIns;
        fa += a.failed;
        so += a.signOuts;
        ac += a.actions;
        active += a.active ? 1 : 0;
      }
      signIns += si;
      failed += fa;
      actionTotal += ac;
      for (const [k, n] of d.entity) {
        tally(entity, k, n);
      }
      for (const k of ACTIONS) {
        byAction[k] += d.action[k];
      }
      return {
        actions: ac,
        activeUsers: active,
        day: d.day,
        failedSignIns: fa,
        signIns: si,
        signOuts: so,
      };
    });

    const dau = activeIds(s.days.slice(-1)).size;
    const wau = activeIds(s.days.slice(-7)).size;
    const mau = activeIds(s.days).size;

    const method = new Map<string, number>();
    const browser = new Map<string, number>();
    const os = new Map<string, number>();
    const hours: number[] = new Array(24).fill(0);
    let oldestSign = Number.POSITIVE_INFINITY;
    for (const r of s.signRows) {
      const at = r.createdAt.getTime();
      oldestSign = Math.min(oldestSign, at);
      if (at < windowStart) {
        continue;
      }
      // Breakdowns count successful sign-ins only, so they sum to `signIns.total`; failures
      // are reported on their own.
      if (r.kind === 'sign_in') {
        tally(method, propString(r.props, 'method'));
        tally(browser, propString(r.props, 'browser'));
        tally(os, propString(r.props, 'os'));
        hours[r.createdAt.getUTCHours()] += 1;
      }
    }
    let oldestAction = Number.POSITIVE_INFINITY;
    for (const t of s.actionTimes) {
      oldestAction = Math.min(oldestAction, t.getTime());
      if (t.getTime() >= windowStart) {
        hours[t.getUTCHours()] += 1;
      }
    }
    const truncated =
      (s.signRowsCapped && oldestSign > windowStart) ||
      (s.actionTimesCapped && oldestAction > windowStart);

    const top = [...totalsByActor.entries()]
      .filter(([, t]) => t.actions > 0)
      .sort((a, b) => b[1].actions - a[1].actions)
      .slice(0, 10);
    const failureRows = await prisma.userActivityEvent.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { actorId: true, createdAt: true, id: true, ip: true, props: true },
      take: 20,
      where: { kind: 'sign_in_failed' },
    });
    const lookupIds = [
      ...new Set([
        ...top.map(([id]) => id),
        ...failureRows.flatMap((r) => (r.actorId ? [r.actorId] : [])),
      ]),
    ];
    const [users, total, newInWindow, activeSessions, everSignedIn] = await Promise.all([
      lookupIds.length
        ? prisma.user.findMany({
            select: { email: true, id: true, name: true },
            where: { id: { in: lookupIds } },
          })
        : Promise.resolve([]),
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: new Date(windowStart) } } }),
      prisma.session.count({ where: { expiresAt: { gt: now } } }),
      // Grouped in the database: `findMany({ distinct })` dedupes in gateway memory, after
      // reading every sign-in row ever written.
      prisma.configAuditLog.groupBy({
        by: ['actorId'],
        orderBy: { actorId: 'asc' },
        take: USER_CAP,
        where: { actorId: { not: null }, entityType: 'Session' },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const signedInIds = everSignedIn.flatMap((r) => (r.actorId ? [r.actorId] : []));
    const neverSignedIn = signedInIds.length
      ? await prisma.user.count({ where: { id: { notIn: signedInIds } } })
      : total;

    return {
      actions: {
        byAction,
        byEntityType: toCounts(entity, 'entityType', 15),
        total: actionTotal,
      },
      activeByDay,
      activeSessions,
      days,
      generatedAt: now.toISOString(),
      peakHours: hours,
      recentFailures: failureRows.map((r) => ({
        createdAt: r.createdAt.toISOString(),
        email: r.actorId ? (userById.get(r.actorId)?.email ?? null) : null,
        id: r.id,
        ip: r.ip,
        method: propString(r.props, 'method'),
        reason: propString(r.props, 'reason'),
        userId: r.actorId,
      })),
      signIns: {
        byBrowser: toCounts(browser, 'name'),
        byMethod: toCounts(method, 'method'),
        byOs: toCounts(os, 'name'),
        failed,
        total: signIns,
      },
      topUsers: top.map(([id, t]) => ({
        actions: t.actions,
        email: userById.get(id)?.email ?? null,
        lastActiveAt: iso(t.lastActive),
        name: userById.get(id)?.name ?? null,
        signIns: t.signIns,
        userId: id,
      })),
      truncated,
      users: {
        dau,
        mau,
        neverSignedIn,
        newInWindow,
        stickinessPct: mau === 0 ? 0 : round1((dau / mau) * 100),
        total,
        wau,
      },
    };
  }

  app.get(
    '/analytics/overview',
    {
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { querystring: DaysQuery },
    },
    async (request) => {
      const { days } = request.query;
      const hit = overviewCache.get(days);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return hit.value;
      }
      const entry = { at: Date.now(), value: buildOverview(days) as Promise<unknown> };
      overviewCache.set(days, entry);
      entry.value.catch(() => {
        if (overviewCache.get(days) === entry) {
          overviewCache.delete(days);
        }
      });
      return entry.value;
    }
  );

  /** Every matching person with the window's aggregates, in the requested order (up to USER_CAP). */
  async function buildPeopleRows(
    days: number,
    q: string | undefined,
    sort: z.infer<typeof UsersQuery>['sort'],
    order: 'asc' | 'desc'
  ) {
    const s = await getScan();
    const totals = sumByActor(windowOf(s, days));
    const [people, sessionGroups] = await Promise.all([
      prisma.user.findMany({
        orderBy: { email: 'asc' },
        select: { createdAt: true, email: true, id: true, name: true, role: true },
        take: USER_CAP + 1,
        where: q
          ? {
              OR: [
                { email: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
      }),
      prisma.session.groupBy({
        _count: { _all: true },
        by: ['userId'],
        where: { expiresAt: { gt: new Date() } },
      }),
    ]);
    const truncated = people.length > USER_CAP;
    const sessionsBy = new Map(sessionGroups.map((g) => [g.userId, g._count._all]));
    const rows = people.slice(0, USER_CAP).map((u) => {
      const t = totals.get(u.id);
      return {
        actions: t?.actions ?? 0,
        activeDays: t?.activeDays ?? 0,
        activeSessions: sessionsBy.get(u.id) ?? 0,
        createdAt: u.createdAt,
        email: u.email,
        failedSignIns: t?.failed ?? 0,
        lastActive: t?.lastActive ?? 0,
        lastSignIn: t?.lastSignIn ?? 0,
        name: u.name,
        role: u.role,
        signIns: t?.signIns ?? 0,
        userId: u.id,
      };
    });
    const dir = order === 'asc' ? 1 : -1;
    const key = (r: (typeof rows)[number]): number | string =>
      sort === 'email'
        ? r.email.toLowerCase()
        : sort === 'actions'
          ? r.actions
          : sort === 'signIns'
            ? r.signIns
            : sort === 'failed'
              ? r.failedSignIns
              : r.lastActive;
    rows.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = ka < kb ? -1 : ka > kb ? 1 : 0;
      return c * dir || a.email.localeCompare(b.email);
    });
    return { rows, truncated };
  }

  type PersonRow = Awaited<ReturnType<typeof buildPeopleRows>>['rows'][number];

  /** The list's wire shape, with the all-time last sign-in read for just these people. */
  async function presentPeople(people: PersonRow[]) {
    const ids = people.map((r) => r.userId);
    const lastIn = ids.length
      ? await prisma.userActivityEvent.groupBy({
          _max: { createdAt: true },
          by: ['actorId'],
          where: { actorId: { in: ids }, kind: 'sign_in' },
        })
      : [];
    const lastInBy = new Map(lastIn.map((g) => [g.actorId, g._max.createdAt?.getTime() ?? 0]));
    return people.map((r) => ({
      actions: r.actions,
      activeDays: r.activeDays,
      activeSessions: r.activeSessions,
      createdAt: r.createdAt.toISOString(),
      email: r.email,
      failedSignIns: r.failedSignIns,
      // Window-scoped, the value the list sorts on; `lastSignInAt` is all-time.
      lastActiveAt: iso(r.lastActive),
      lastSignInAt: iso(Math.max(r.lastSignIn, lastInBy.get(r.userId) ?? 0)),
      name: r.name,
      role: r.role,
      signIns: r.signIns,
      userId: r.userId,
    }));
  }

  app.get(
    '/analytics/users',
    {
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { querystring: UsersQuery },
    },
    async (request) => {
      const { days, limit, offset, order, q, sort } = request.query;
      const { rows, truncated } = await buildPeopleRows(days, q, sort, order);
      return {
        // All-time last sign-in for the page only, so a quiet person still shows one.
        data: await presentPeople(rows.slice(offset, offset + limit)),
        meta: { days, limit, offset, total: rows.length, truncated },
      };
    }
  );

  // Registered before `/analytics/users/:id`; find-my-way ranks a static segment above a
  // parameter either way, and the route test pins it. The export is itself a recorded `export`.
  app.get(
    '/analytics/users/export',
    {
      config: { activity: 'export' },
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { querystring: ExportQuery },
    },
    async (request, reply) => {
      const { days, order, q, sort } = request.query;
      const { rows, truncated } = await buildPeopleRows(days, q, sort, order);
      if (truncated) {
        // A partial file would read as the whole population, so refuse it instead.
        return sendError(
          reply,
          413,
          'EXPORT_TOO_LARGE',
          `More than ${USER_CAP} people match, so the export would be incomplete. Narrow the search with q and export again.`
        );
      }
      const people = await presentPeople(rows);
      const body =
        csvRow(EXPORT_COLUMNS) +
        people.map((p) => csvRow(EXPORT_COLUMNS.map((c) => p[c]))).join('');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="user-analytics-${days}d.csv"`)
        .header('cache-control', 'no-store')
        .header('x-export-row-limit', String(USER_CAP))
        .header('x-export-truncated', 'false')
        .send(body);
    }
  );

  app.get(
    '/analytics/users/:id',
    {
      // An admin opening a person's profile is itself a sensitive read (docs/user-activity.md).
      config: { activity: 'read' },
      onRequest: requireAuth({ capability: 'platform.audit.read' }),
      schema: { params: IdParams, querystring: DaysQuery },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { days } = request.query;
      const user = await prisma.user.findUnique({
        select: {
          createdAt: true,
          email: true,
          id: true,
          memberships: { select: { role: true, team: { select: { id: true, slug: true } } } },
          name: true,
          role: true,
        },
        where: { id },
      });
      if (!user) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'User not found' });
      }
      const windowStart = startOfUtcDay(Date.now()) - (days - 1) * DAY_MS;
      const since = new Date(windowStart);
      const notSession = { not: 'Session' };
      const [
        kindGroups,
        entityGroups,
        eventRows,
        auditRows,
        history,
        recent,
        pages,
        sessions,
        firstEvent,
        firstAudit,
        lastIn,
      ] = await Promise.all([
        prisma.userActivityEvent.groupBy({
          _count: { _all: true },
          by: ['kind'],
          where: { actorId: id, createdAt: { gte: since }, kind: { in: [...SIGN_KINDS] } },
        }),
        prisma.configAuditLog.groupBy({
          _count: { _all: true },
          by: ['entityType', 'action'],
          where: { actorId: id, createdAt: { gte: since }, entityType: notSession },
        }),
        prisma.userActivityEvent.findMany({
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, kind: true },
          take: ROW_CAP,
          where: { actorId: id, createdAt: { gte: since }, kind: { in: COUNTED_KINDS } },
        }),
        prisma.configAuditLog.findMany({
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
          take: ROW_CAP,
          where: { actorId: id, createdAt: { gte: since }, entityType: notSession },
        }),
        prisma.userActivityEvent.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true, id: true, ip: true, kind: true, props: true },
          take: HISTORY_LIMIT,
          where: { actorId: id, kind: { in: [...SIGN_KINDS] } },
        }),
        prisma.configAuditLog.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            action: true,
            context: true,
            createdAt: true,
            entityId: true,
            entityType: true,
            id: true,
          },
          take: HISTORY_LIMIT,
          where: { actorId: id, entityType: notSession },
        }),
        prisma.userActivityEvent.groupBy({
          _count: { _all: true },
          by: ['route'],
          orderBy: { _count: { route: 'desc' } },
          take: 10,
          where: { actorId: id, createdAt: { gte: since }, kind: 'ui' },
        }),
        prisma.session.findMany({
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            expiresAt: true,
            id: true,
            ipAddress: true,
            userAgent: true,
          },
          take: HISTORY_LIMIT,
          where: { expiresAt: { gt: new Date() }, userId: id },
        }),
        prisma.userActivityEvent.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
          where: { actorId: id },
        }),
        prisma.configAuditLog.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
          where: { actorId: id },
        }),
        prisma.userActivityEvent.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
          where: { actorId: id, kind: 'sign_in' },
        }),
      ]);

      const kindCount = (k: string) => kindGroups.find((g) => g.kind === k)?._count._all ?? 0;
      const entity = new Map<string, number>();
      const byAction = { CREATE: 0, DELETE: 0, UPDATE: 0 };
      let actions = 0;
      for (const g of entityGroups) {
        tally(entity, g.entityType, g._count._all);
        byAction[g.action as ActionName] += g._count._all;
        actions += g._count._all;
      }

      const dayCells = new Map<
        string,
        { signIns: number; failedSignIns: number; actions: number }
      >();
      for (let i = 0; i < days; i++) {
        dayCells.set(dayKey(windowStart + i * DAY_MS), {
          actions: 0,
          failedSignIns: 0,
          signIns: 0,
        });
      }
      const activeDays = new Set<string>();
      let lastActive = 0;
      for (const r of eventRows) {
        const cell = dayCells.get(dayKey(r.createdAt.getTime()));
        if (r.kind === 'sign_in' && cell) {
          cell.signIns += 1;
        }
        if (r.kind === 'sign_in_failed' && cell) {
          cell.failedSignIns += 1;
        }
        if ((ACTIVE_USER_EVENT_KINDS as readonly string[]).includes(r.kind)) {
          activeDays.add(dayKey(r.createdAt.getTime()));
          lastActive = Math.max(lastActive, r.createdAt.getTime());
        }
      }
      for (const r of auditRows) {
        const cell = dayCells.get(dayKey(r.createdAt.getTime()));
        if (cell) {
          cell.actions += 1;
        }
        activeDays.add(dayKey(r.createdAt.getTime()));
        lastActive = Math.max(lastActive, r.createdAt.getTime());
      }
      const lastSignIn = lastIn?.createdAt.getTime() ?? 0;
      const firsts = [firstEvent?.createdAt, firstAudit?.createdAt].flatMap((d) =>
        d ? [d.getTime()] : []
      );
      const oldestEvent = eventRows.at(-1)?.createdAt.getTime() ?? Number.POSITIVE_INFINITY;
      const oldestAudit = auditRows.at(-1)?.createdAt.getTime() ?? Number.POSITIVE_INFINITY;
      const truncated =
        (eventRows.length >= ROW_CAP && oldestEvent > windowStart) ||
        (auditRows.length >= ROW_CAP && oldestAudit > windowStart);

      return {
        actionsByAction: byAction,
        actionsByEntityType: toCounts(entity, 'entityType', 20),
        daily: [...dayCells.entries()].map(([day, c]) => ({ day, ...c })),
        recentActions: recent.map((r) => {
          const via = (r.context as { via?: unknown } | null)?.via;
          return {
            action: r.action,
            createdAt: r.createdAt.toISOString(),
            entityId: r.entityId,
            entityType: r.entityType,
            id: r.id,
            via: typeof via === 'string' ? via : null,
          };
        }),
        sessions: sessions.map((x) => ({
          createdAt: x.createdAt.toISOString(),
          expiresAt: x.expiresAt.toISOString(),
          id: x.id,
          ipTruncated: truncateIp(x.ipAddress) ?? null,
          ...parseUserAgent(x.userAgent),
        })),
        signInHistory: history.map((r) => ({
          browser: propString(r.props, 'browser'),
          createdAt: r.createdAt.toISOString(),
          id: r.id,
          ip: r.ip,
          kind: r.kind as 'sign_in' | 'sign_in_failed' | 'sign_out',
          method: r.kind === 'sign_out' ? null : propString(r.props, 'method'),
          os: propString(r.props, 'os'),
          reason: r.kind === 'sign_in_failed' ? propString(r.props, 'reason') : null,
        })),
        summary: {
          actions,
          activeDays: activeDays.size,
          failedSignIns: kindCount('sign_in_failed'),
          firstSeenAt: firsts.length ? iso(Math.min(...firsts)) : null,
          lastActiveAt: iso(Math.max(lastActive, lastSignIn)),
          lastSignInAt: iso(lastSignIn),
          signIns: kindCount('sign_in'),
          signOuts: kindCount('sign_out'),
        },
        topPages: pages.map((p) => ({ count: p._count._all, route: p.route })),
        truncated,
        user: {
          createdAt: user.createdAt.toISOString(),
          email: user.email,
          id: user.id,
          name: user.name,
          role: user.role,
          teams: user.memberships.map((m) => ({
            id: m.team.id,
            role: m.role,
            slug: m.team.slug,
          })),
        },
      };
    }
  );
};
