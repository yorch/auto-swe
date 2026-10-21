import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auditContextOf } from './auditContext.js';
import { recordActivityEventsDropped, recordHttpDenied } from './metrics.js';

/**
 * First-party activity events (docs/user-activity.md): who was refused, who looked at something
 * sensitive, and, when an operator opts in, which dashboard pages were opened.
 *
 * Rows are built from the request object in an `onResponse` hook, never from the async store (it is
 * unreliable there), and carry the route TEMPLATE the router matched (`/api/v1/runs/:id`), never the
 * URL: no ids, query strings, bodies or secrets. They go through a bounded in-memory queue that
 * drops, and counts, instead of blocking or growing, and is flushed in batches. Recording never
 * fails a request.
 */

export type ActivityKind = 'denied' | 'read' | 'export' | 'ui';

export interface ActivityEventRow {
  actorId: string | null;
  via: string | null;
  kind: ActivityKind;
  /** A route template, never a URL. */
  route: string;
  method: string;
  status: number | null;
  requestId: string | null;
  /** Truncated: /24 for IPv4, /48 for IPv6. */
  ip: string | null;
  props?: Record<string, string | number | boolean | null>;
}

/** A `read` or `export` row for one actor and route is written at most this often. */
export const READ_DEDUPE_MS = 10 * 60_000;
/** A `denied` row for one actor, route and status is written at most this often. */
export const DENIED_DEDUPE_MS = 60_000;
/** The same page view from one actor is collapsed within this window (five seconds). */
export const UI_DEDUPE_MS = 5000;
/** Distinct dedupe keys held at once; the oldest are forgotten first, so memory stays bounded. */
const DEDUPE_MAX_KEYS = 5000;
/**
 * Events one actor may add per minute, with a bucket of its own for each kind: a person flooding
 * page views or reads cannot use up the budget that records their exports or denials. The excess is
 * dropped and counted. Denials get a generous cap of their own, which still bounds a flood of them.
 */
export const ACTOR_EVENTS_PER_MINUTE: Readonly<Record<ActivityKind, number>> = {
  denied: 120,
  export: 60,
  read: 60,
  ui: 60,
};
/** Buckets tracked at once (an actor and kind each); the least recently used are forgotten first. */
const ACTOR_BUCKETS_MAX = 20_000;
/** How long shutdown waits for the queue to flush before giving up on a database that is down. */
const STOP_TIMEOUT_MS = 3000;

/** Kinds that must survive a full queue; `ui` and `read` are evicted first. */
const HIGH_PRIORITY: ReadonlySet<ActivityKind> = new Set(['denied', 'export']);

export interface ActivityQueueOptions {
  write: (rows: ActivityEventRow[]) => Promise<void>;
  /** Events held at once. */
  maxQueue?: number;
  /** Rows per write. */
  batchSize?: number;
  flushIntervalMs?: number;
  onDrop?: (count: number) => void;
  /** Clock, for tests. */
  now?: () => number;
  /** Events per actor per minute, per kind. */
  actorEventsPerMinute?: Partial<Record<ActivityKind, number>>;
}

/**
 * A bounded queue of events, flushed in batches. Dropping is the only overflow behaviour. When it is
 * full, a `denied` or `export` event evicts the oldest `ui` event, then the oldest `read` event,
 * before it is dropped itself; a `ui` or `read` event never displaces anything.
 */
export class ActivityQueue {
  private rows: ActivityEventRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private readonly seen = new Map<string, number>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Events dropped since this process started (queue full, rate-limited, or a failed write). */
  dropped = 0;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly perMinute: Record<ActivityKind, number>;

  constructor(private readonly opts: ActivityQueueOptions) {
    this.maxQueue = opts.maxQueue ?? 1000;
    this.batchSize = opts.batchSize ?? 100;
    this.now = opts.now ?? Date.now;
    this.perMinute = { ...ACTOR_EVENTS_PER_MINUTE, ...opts.actorEventsPerMinute };
  }

  get size(): number {
    return this.rows.length;
  }

  /** True while `key` was recorded within its window. Not a drop: collapsing a repeat is the point. */
  private remembered(key: string): boolean {
    const until = this.seen.get(key);
    return until !== undefined && until > this.now();
  }

  /** Remember `key` for `ttlMs`; the oldest keys are forgotten past the bound. */
  private remember(key: string, ttlMs: number): void {
    const now = this.now();
    this.seen.delete(key);
    this.seen.set(key, now + ttlMs);
    for (const [k, expires] of this.seen) {
      if (this.seen.size <= DEDUPE_MAX_KEYS && expires > now) {
        break;
      }
      this.seen.delete(k);
    }
  }

  /** A token bucket per actor and kind, refilled continuously. */
  private takeToken(actor: string, kind: ActivityKind): boolean {
    const perMinute = this.perMinute[kind];
    const id = `${kind}|${actor}`;
    const now = this.now();
    const bucket = this.buckets.get(id) ?? { at: now, tokens: perMinute };
    // A clock that steps backwards refills nothing rather than draining the bucket.
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(perMinute, bucket.tokens + (elapsed / 60_000) * perMinute);
    bucket.at = Math.max(bucket.at, now);
    this.buckets.delete(id);
    this.buckets.set(id, bucket);
    if (this.buckets.size > ACTOR_BUCKETS_MAX) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) {
        this.buckets.delete(oldest);
      }
    }
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Queue one event; returns false when it was collapsed into a recent identical one (`dedupe`),
   * rate-limited, or did not fit. The dedupe key is remembered only when the event is accepted, so
   * a dropped event never silences the next identical one.
   */
  enqueue(row: ActivityEventRow, dedupe?: { key: string; ttlMs: number }): boolean {
    if (dedupe && this.remembered(dedupe.key)) {
      return false;
    }
    if (!this.takeToken(row.actorId ?? 'none', row.kind)) {
      this.drop(1);
      return false;
    }
    if (this.rows.length >= this.maxQueue && !this.makeRoomFor(row)) {
      this.drop(1);
      return false;
    }
    if (dedupe) {
      this.remember(dedupe.key, dedupe.ttlMs);
    }
    this.rows.push(row);
    if (this.rows.length >= this.batchSize) {
      void this.flush();
    }
    return true;
  }

  /** Evict the oldest `ui`, then `read`, event for a high-priority one; the eviction is a drop. */
  private makeRoomFor(row: ActivityEventRow): boolean {
    if (!HIGH_PRIORITY.has(row.kind)) {
      return false;
    }
    for (const kind of ['ui', 'read'] as const) {
      const index = this.rows.findIndex((r) => r.kind === kind);
      if (index >= 0) {
        this.rows.splice(index, 1);
        this.drop(1);
        return true;
      }
    }
    return false;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 5000);
    this.timer.unref();
  }

  /** Stop the timer and flush, giving up after a few seconds so a down database cannot hang shutdown. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    let giveUp: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      giveUp = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.flush(), timeout]);
    } finally {
      clearTimeout(giveUp);
    }
  }

  /** Write everything queued, one batch at a time. A failed batch is dropped, not retried. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.rows.length > 0) {
      const batch = this.rows.splice(0, this.batchSize);
      try {
        await this.opts.write(batch);
      } catch {
        this.drop(batch.length);
      }
    }
  }

  private drop(count: number): void {
    this.dropped += count;
    try {
      this.opts.onDrop?.(count);
    } catch {
      // The metric is best-effort: it must not throw out of a flush or a request.
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    activityQueue: ActivityQueue;
  }
}

/** The event for a finished request, or `null` when it is not one that is recorded. */
export function activityEventFor(
  request: FastifyRequest,
  reply: FastifyReply
): ActivityEventRow | null {
  const route = request.routeOptions?.url;
  if (!route) {
    // No matched route: a 404, which is not a denial of anything.
    return null;
  }
  const status = reply.statusCode;
  const base = () => {
    const context = auditContextOf(request);
    return {
      actorId: request.user?.sub ?? null,
      ip: context.ip ?? null,
      method: request.method,
      requestId: context.requestId ?? null,
      route,
      status,
      via: context.via ?? null,
    };
  };
  if (status === 403 && request.user) {
    return { ...base(), kind: 'denied' };
  }
  // A route opts in with `config: { activity }`, so every mount of it (a deprecated alias
  // included) is covered, and only a successful GET is a read.
  const tagged = request.routeOptions.config?.activity;
  if (tagged && request.method === 'GET' && status === 200) {
    return { ...base(), kind: tagged };
  }
  return null;
}

export const activityEvents = fp<{
  maxQueue?: number;
  batchSize?: number;
  flushIntervalMs?: number;
}>(
  async (app: FastifyInstance, options) => {
    const queue = new ActivityQueue({
      ...options,
      onDrop: recordActivityEventsDropped,
      write: async (rows) => {
        await app.prisma.userActivityEvent.createMany({
          data: rows.map((r) => ({ ...r, props: r.props ?? undefined })),
        });
      },
    });
    app.decorate('activityQueue', queue);
    queue.start();
    app.addHook('onClose', async () => {
      await queue.stop();
    });

    app.addHook('onResponse', async (request, reply) => {
      try {
        const route = request.routeOptions?.url;
        const status = reply.statusCode;
        if (route && (status === 401 || status === 403)) {
          recordHttpDenied(route, status, Boolean(request.user));
        }
        const event = activityEventFor(request, reply);
        if (event) {
          // A poller refreshing a page does not write a row per refresh.
          const key =
            event.kind === 'denied'
              ? `denied|${event.actorId}|${event.route}|${event.status}`
              : `${event.kind}|${event.actorId}|${event.route}`;
          queue.enqueue(event, {
            key,
            ttlMs: event.kind === 'denied' ? DENIED_DEDUPE_MS : READ_DEDUPE_MS,
          });
        }
      } catch (err) {
        request.log.warn({ err }, 'activity event could not be recorded');
      }
    });
  },
  { fastify: '5.x', name: 'activity-events' }
);
