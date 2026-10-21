import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApiRoutes } from '../routes/register.js';
import {
  type ActivityEventRow,
  ActivityQueue,
  activityEventFor,
  activityEvents,
} from './activityEvents.js';
import { _resetMetricsForTests } from './metrics.js';

const row = (route: string): ActivityEventRow => ({
  actorId: null,
  ip: null,
  kind: 'denied',
  method: 'GET',
  requestId: null,
  route,
  status: 403,
  via: null,
});

describe('ActivityQueue', () => {
  it('flushes in batches', async () => {
    const write = vi.fn(async (_rows: ActivityEventRow[]) => {});
    const queue = new ActivityQueue({ batchSize: 2, write });
    for (const r of ['/a', '/b', '/c']) {
      queue.enqueue(row(r));
    }
    await queue.flush();
    expect(write.mock.calls.map(([rows]) => rows.map((r) => r.route))).toEqual([
      ['/a', '/b'],
      ['/c'],
    ]);
    expect(queue.size).toBe(0);
  });

  it('drops, and counts, rather than growing past its bound', () => {
    const onDrop = vi.fn();
    const queue = new ActivityQueue({
      batchSize: 1000,
      maxQueue: 2,
      onDrop,
      write: async () => {},
    });
    expect([1, 2, 3].map((i) => queue.enqueue(row(`/${i}`)))).toEqual([true, true, false]);
    expect(queue.size).toBe(2);
    expect(queue.dropped).toBe(1);
    expect(onDrop).toHaveBeenCalledWith(1);
  });

  it('drops a batch whose write fails, and carries on', async () => {
    const write = vi
      .fn<(rows: ActivityEventRow[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const queue = new ActivityQueue({ batchSize: 1, write });
    queue.enqueue(row('/a'));
    queue.enqueue(row('/b'));
    await queue.flush();
    await queue.flush();
    expect(queue.dropped).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe('ActivityQueue bounds', () => {
  const ev = (kind: ActivityEventRow['kind'], actorId: string | null = null): ActivityEventRow => ({
    ...row(`/${kind}`),
    actorId,
    kind,
  });

  it('lets a denied or export event evict the oldest ui, then read, event when full', async () => {
    const written: ActivityEventRow[] = [];
    const queue = new ActivityQueue({
      batchSize: 1000,
      maxQueue: 3,
      write: async (rows) => {
        written.push(...rows);
      },
    });
    queue.enqueue(ev('read'));
    queue.enqueue(ev('ui'));
    queue.enqueue(ev('denied'));
    // ui and read never displace anything.
    expect(queue.enqueue(ev('ui'))).toBe(false);
    expect(queue.enqueue(ev('read'))).toBe(false);
    // A denial evicts the ui event first, an export the read event next.
    expect(queue.enqueue(ev('denied'))).toBe(true);
    expect(queue.enqueue(ev('export'))).toBe(true);
    // Only high-priority events are left, so a further one is dropped.
    expect(queue.enqueue(ev('denied'))).toBe(false);
    await queue.flush();
    expect(written.map((r) => r.kind)).toEqual(['denied', 'denied', 'export']);
    expect(queue.dropped).toBe(5);
  });

  it('limits each actor to a per-minute budget and refills it over time', () => {
    let now = 0;
    const queue = new ActivityQueue({
      actorEventsPerMinute: { ui: 3 },
      batchSize: 1000,
      now: () => now,
      write: async () => {},
    });
    const results = [1, 2, 3, 4].map(() => queue.enqueue(ev('ui', 'a')));
    expect(results).toEqual([true, true, true, false]);
    // Another actor is unaffected.
    expect(queue.enqueue(ev('ui', 'b'))).toBe(true);
    now += 20_000;
    expect(queue.enqueue(ev('ui', 'a'))).toBe(true);
    expect(queue.dropped).toBe(1);
  });

  it('remembers a dedupe key for its window only', () => {
    let now = 0;
    const queue = new ActivityQueue({ now: () => now, write: async () => {} });
    const d = { key: 'k', ttlMs: 1000 };
    expect(queue.enqueue(ev('read', 'a'), d)).toBe(true);
    expect(queue.enqueue(ev('read', 'a'), d)).toBe(false);
    expect(queue.enqueue(ev('read', 'a'), { key: 'other', ttlMs: 1000 })).toBe(true);
    now = 1001;
    expect(queue.enqueue(ev('read', 'a'), d)).toBe(true);
    // Collapsing a repeat is not a drop.
    expect(queue.dropped).toBe(0);
  });

  it('keeps ui and denied floods from using up the budget that records an export', async () => {
    const written: ActivityEventRow[] = [];
    const queue = new ActivityQueue({
      batchSize: 1000,
      write: async (rows) => {
        written.push(...rows);
      },
    });
    for (let i = 0; i < 200; i++) {
      queue.enqueue({ ...ev('ui', 'a'), route: `/ui/${i}` });
      queue.enqueue({ ...ev('denied', 'a'), route: `/denied/${i}` });
      queue.enqueue({ ...ev('read', 'a'), route: `/read/${i}` });
    }
    expect(queue.enqueue(ev('export', 'a'), { key: 'export|a|/x', ttlMs: 600_000 })).toBe(true);
    // The first rows of each flood were kept, the rest dropped; the export is among them.
    await queue.flush();
    expect(written.filter((r) => r.kind === 'export')).toHaveLength(1);
    expect(written.filter((r) => r.kind === 'ui')).toHaveLength(60);
    expect(written.filter((r) => r.kind === 'denied')).toHaveLength(120);
    expect(queue.dropped).toBeGreaterThan(0);
  });

  it('does not remember the dedupe key of an event it dropped', () => {
    let now = 0;
    const queue = new ActivityQueue({
      actorEventsPerMinute: { export: 1 },
      batchSize: 1000,
      now: () => now,
      write: async () => {},
    });
    const d = { key: 'export|a|/x', ttlMs: 600_000 };
    expect(queue.enqueue(ev('export', 'a'), { key: 'other', ttlMs: 600_000 })).toBe(true);
    // Budget spent: this one is dropped, and must not silence the identical event after the refill.
    expect(queue.enqueue(ev('export', 'a'), d)).toBe(false);
    expect(queue.dropped).toBe(1);
    now += 61_000;
    expect(queue.enqueue(ev('export', 'a'), d)).toBe(true);
    expect(queue.enqueue(ev('export', 'a'), d)).toBe(false);
  });

  it('refills nothing, and loses nothing, when the clock steps backwards', () => {
    let now = 100_000;
    const queue = new ActivityQueue({
      actorEventsPerMinute: { ui: 2 },
      batchSize: 1000,
      now: () => now,
      write: async () => {},
    });
    expect(queue.enqueue(ev('ui', 'a'))).toBe(true);
    now = 50_000;
    expect(queue.enqueue(ev('ui', 'a'))).toBe(true);
    expect(queue.enqueue(ev('ui', 'a'))).toBe(false);
    now = 100_000 + 30_000;
    expect(queue.enqueue(ev('ui', 'a'))).toBe(true);
  });

  it('survives a drop callback that throws', async () => {
    const queue = new ActivityQueue({
      batchSize: 1,
      onDrop: () => {
        throw new Error('metrics down');
      },
      write: async () => {
        throw new Error('db down');
      },
    });
    queue.enqueue(ev('denied'));
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.dropped).toBe(1);
  });

  it('gives up flushing at shutdown when the database hangs', async () => {
    vi.useFakeTimers();
    try {
      const queue = new ActivityQueue({ write: () => new Promise(() => {}) });
      queue.enqueue(ev('denied'));
      const stopped = queue.stop();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

describe('activityEvents hook', () => {
  let reader: TestReader;
  const createMany = vi.fn(async (_args: unknown) => ({ count: 0 }));

  beforeEach(() => {
    reader = new TestReader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    _resetMetricsForTests();
    createMany.mockClear();
  });
  afterEach(() => {
    metrics.disable();
    _resetMetricsForTests();
  });

  async function build() {
    const app = Fastify({ trustProxy: false });
    app.decorate('prisma', { userActivityEvent: { createMany } } as never);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-user']) {
        request.user = { role: 'ENGINEER', sub: String(request.headers['x-user']) } as never;
        request.authMethod = 'pat';
      }
    });
    await app.register(activityEvents);
    app.get('/api/v1/denied', async (_req, reply) => reply.status(403).send({}));
    app.get('/api/v1/unauth', async (_req, reply) => reply.status(401).send({}));
    app.get('/api/v1/platform/audit-log', { config: { activity: 'read' } }, async () => ({
      ok: true,
    }));
    // A deprecated alias mount of the same route carries the same tag.
    app.get('/api/v1/admin/audit-log', { config: { activity: 'read' } }, async () => ({
      ok: true,
    }));
    app.get(
      '/api/v1/platform/audit-log/export',
      { config: { activity: 'export' } },
      async () => 'csv'
    );
    app.get('/api/v1/other/:id', async () => ({ ok: true }));
    app.post('/api/v1/platform/audit-log', { config: { activity: 'read' } }, async () => ({
      ok: true,
    }));
    await app.ready();
    return app;
  }

  const stored = () =>
    createMany.mock.calls.flatMap(([args]) => (args as { data: ActivityEventRow[] }).data);

  it('records an authenticated 403 by route template, with no body or query', async () => {
    const app = await build();
    await app.inject({
      headers: { 'x-user': '11111111-1111-4111-8111-111111111111' },
      remoteAddress: '198.51.100.23',
      url: '/api/v1/denied?secret=abc',
    });
    await app.activityQueue.flush();
    expect(stored()).toEqual([
      expect.objectContaining({
        actorId: '11111111-1111-4111-8111-111111111111',
        ip: '198.51.100.0',
        kind: 'denied',
        method: 'GET',
        route: '/api/v1/denied',
        status: 403,
        via: 'pat',
      }),
    ]);
    expect(JSON.stringify(stored())).not.toContain('secret');
    await app.close();
  });

  it('writes no row for an actorless denial, only a metric', async () => {
    const app = await build();
    await app.inject({ url: '/api/v1/denied' });
    await app.inject({ url: '/api/v1/unauth' });
    await app.inject({ headers: { 'x-user': 'u1' }, url: '/api/v1/unauth' });
    await app.activityQueue.flush();
    expect(stored()).toEqual([]);
    const { resourceMetrics } = await reader.collect();
    const denied = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'http.denied');
    const points = (denied?.dataPoints ?? []).map((d) => [
      d.attributes.route,
      d.attributes.status,
      d.attributes.actor,
      d.value,
    ]);
    expect(points).toContainEqual(['/api/v1/denied', 403, 'none', 1]);
    expect(points).toContainEqual(['/api/v1/unauth', 401, 'none', 1]);
    await app.close();
  });

  it('records tagged reads and exports on every mount, and nothing else', async () => {
    const app = await build();
    const headers = { 'x-user': '22222222-2222-4222-8222-222222222222' };
    await app.inject({ headers, url: '/api/v1/platform/audit-log?search=alice' });
    await app.inject({ headers, url: '/api/v1/admin/audit-log' });
    await app.inject({ headers, url: '/api/v1/platform/audit-log/export' });
    await app.inject({ headers, url: '/api/v1/other/abc' });
    await app.inject({ headers, method: 'POST', url: '/api/v1/platform/audit-log' });
    await app.inject({ headers, url: '/api/v1/missing' });
    await app.activityQueue.flush();
    expect(stored().map((r) => [r.kind, r.route])).toEqual([
      ['read', '/api/v1/platform/audit-log'],
      ['read', '/api/v1/admin/audit-log'],
      ['export', '/api/v1/platform/audit-log/export'],
    ]);
    expect(JSON.stringify(stored())).not.toContain('alice');
    await app.close();
  });

  it('writes one row for a polled read per actor and route, and per denial per minute', async () => {
    const app = await build();
    const headers = { 'x-user': '33333333-3333-4333-8333-333333333333' };
    for (let i = 0; i < 5; i++) {
      await app.inject({ headers, url: '/api/v1/platform/audit-log' });
      await app.inject({ headers, url: '/api/v1/denied' });
    }
    // Another person polling the same route is their own row.
    await app.inject({
      headers: { 'x-user': '44444444-4444-4444-8444-444444444444' },
      url: '/api/v1/platform/audit-log',
    });
    await app.activityQueue.flush();
    expect(stored().map((r) => [r.kind, r.actorId?.slice(0, 1)])).toEqual([
      ['read', '3'],
      ['denied', '3'],
      ['read', '4'],
    ]);
    await app.close();
  });

  it('never fails a request when the write fails', async () => {
    createMany.mockRejectedValueOnce(new Error('db down'));
    const app = await build();
    const res = await app.inject({ headers: { 'x-user': 'u1' }, url: '/api/v1/denied' });
    expect(res.statusCode).toBe(403);
    await app.activityQueue.flush();
    expect(app.activityQueue.dropped).toBe(1);
    await app.close();
  });
});

/** The routes meant to be recorded, on every mount. A new mount or tag must be added on purpose. */
const INTENDED_TAGGED = [
  'GET /api/v1/admin/audit-log export:no',
  'GET /api/v1/admin/audit-log/export export:yes',
  'GET /api/v1/platform/audit-log export:no',
  'GET /api/v1/platform/audit-log/export export:yes',
  'GET /api/v1/pull-requests/outcomes/export export:yes',
  'GET /api/v1/workflow-runs/:id export:no',
].sort();

describe('routes tagged for activity recording', () => {
  const tagged: Array<{ key: string; method: string; url: string; activity: 'read' | 'export' }> =
    [];

  beforeAll(async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    for (const name of ['prisma', 'temporal', 'auth', 'mcpBridge', 'activityQueue']) {
      app.decorate(name, {} as never);
    }
    // Every route of every mount, aliases included.
    app.addHook('onRoute', (route) => {
      const activity = (route.config as { activity?: 'read' | 'export' } | undefined)?.activity;
      if (!activity) {
        return;
      }
      for (const method of [route.method].flat()) {
        tagged.push({
          activity,
          key: `${method} ${route.url} export:${activity === 'export' ? 'yes' : 'no'}`,
          method,
          url: route.url,
        });
      }
    });
    await registerApiRoutes(app);
    await app.ready();
    await app.close();
  }, 60_000);

  it('are exactly the intended set, across every mount', () => {
    const keys = tagged
      .filter((t) => t.method === 'GET')
      .map((t) => t.key)
      .sort();
    expect(keys, 'a new mount or tag changes what is recorded: decide it on purpose').toEqual(
      INTENDED_TAGGED
    );
  });

  it('each record a successful GET and nothing else', () => {
    for (const t of tagged.filter((x) => x.method === 'GET')) {
      const request = (method: string) =>
        ({
          id: 'r1',
          ip: '198.51.100.7',
          method,
          routeOptions: { config: { activity: t.activity }, url: t.url },
          user: { sub: 'u1' },
        }) as never;
      const ok = activityEventFor(request('GET'), { statusCode: 200 } as never);
      expect(ok, t.key).toMatchObject({ kind: t.activity, route: t.url });
      expect(activityEventFor(request('GET'), { statusCode: 404 } as never), t.key).toBeNull();
    }
  });

  it('does not tag the activity views, so reading them records nothing', () => {
    expect(tagged.some((t) => t.url.includes('/activity'))).toBe(false);
  });
});
