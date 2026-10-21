import { rollupUsageDay } from '@auto-swe/shared/lib/agentTraceRollup';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageRoutes } from './usage.js';

/**
 * The usage report must say the same thing whether a completed day is read from
 * `agent_trace_daily_usage` or from the live `agent_traces`.
 *
 * This runs against an in-memory stand-in for the two tables that implements just the Prisma
 * `groupBy` / `aggregate` / `createMany` / `deleteMany` semantics the code uses. It therefore
 * proves the rollup code and the report's merge, boundary and fallback logic agree with each other
 * on one fixture; it does NOT prove the SQL agrees — `usage.rollup.pg.test.ts` runs the same
 * comparison against Postgres.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const TODAY = Date.parse('2026-10-20T00:00:00.000Z');
const day = (n: number) => TODAY + n * DAY_MS; // n days from today's midnight (negative = past)

const TEAM_A = '00000000-0000-4000-8000-00000000000a';
const TEAM_B = '00000000-0000-4000-8000-00000000000b';
const ORG_1 = '00000000-0000-4000-8000-0000000000a1';
const ORG_2 = '00000000-0000-4000-8000-0000000000a2';
const U_ALICE = '00000000-0000-4000-8000-0000000000c1';
const U_BOB = '00000000-0000-4000-8000-0000000000c2';
const U_CARL = '00000000-0000-4000-8000-0000000000c3';
const RUN_1 = '00000000-0000-4000-8000-0000000000d1';
const RUN_2 = '00000000-0000-4000-8000-0000000000d2';
const RUN_3 = '00000000-0000-4000-8000-0000000000d3';
const RUN_REUSED = '00000000-0000-4000-8000-0000000000d4';

type Row = Record<string, unknown>;

// ── a minimal Prisma-shaped engine over arrays ────────────────────────────────────────────────

const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function matchesField(value: unknown, cond: unknown): boolean {
  if (cond === null) {
    return value === null || value === undefined;
  }
  if (cond instanceof Date || typeof cond !== 'object') {
    return ms(value) === ms(cond);
  }
  const c = cond as Record<string, unknown>;
  const v = ms(value);
  return Object.entries(c).every(([op, arg]) => {
    switch (op) {
      case 'gte':
        return v !== null && v !== undefined && (v as number) >= (ms(arg) as number);
      case 'lt':
        return v !== null && v !== undefined && (v as number) < (ms(arg) as number);
      case 'lte':
        return v !== null && v !== undefined && (v as number) <= (ms(arg) as number);
      case 'gt':
        return v !== null && v !== undefined && (v as number) > (ms(arg) as number);
      case 'in':
        return (arg as unknown[]).map(ms).includes(v);
      case 'not':
        return arg === null ? v !== null && v !== undefined : v !== ms(arg);
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') {
      return (cond as Row[]).some((w) => matches(row, w));
    }
    return matchesField(row[k], cond);
  });
}

const sumOf = (rows: Row[], f: string) => {
  const vals = rows.map((r) => r[f]).filter((x) => x !== null && x !== undefined) as number[];
  return vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
};

function aggregates(rows: Row[], args: Row) {
  const out: Row = {};
  if (args._count) {
    out._count = Object.fromEntries(
      Object.keys(args._count as Row).map((f) => [
        f,
        f === '_all' ? rows.length : rows.filter((r) => r[f] !== null && r[f] !== undefined).length,
      ])
    );
  }
  if (args._sum) {
    out._sum = Object.fromEntries(Object.keys(args._sum as Row).map((f) => [f, sumOf(rows, f)]));
  }
  return out;
}

function table(rows: Row[]) {
  const filter = (where?: Row) => rows.filter((r) => matches(r, where));
  return {
    aggregate: async (args: Row) => aggregates(filter(args.where as Row), args),
    createMany: async ({ data }: { data: Row[] }) => {
      rows.push(...data.map((d) => ({ ...d })));
      return { count: data.length };
    },
    deleteMany: async ({ where }: { where?: Row }) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
    findMany: async (args: Row = {}) => filter(args.where as Row),
    groupBy: async (args: Row) => {
      const by = args.by as string[];
      const groups = new Map<string, Row[]>();
      for (const r of filter(args.where as Row)) {
        const k = JSON.stringify(by.map((f) => ms(r[f] ?? null)));
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      let out = [...groups.values()].map((g) => ({
        ...Object.fromEntries(by.map((f) => [f, g[0]?.[f] ?? null])),
        ...aggregates(g, args),
      })) as Row[];
      const having = args.having as { costUsd?: { _sum?: { gt: number } } } | undefined;
      if (having?.costUsd?._sum) {
        const min = having.costUsd._sum.gt;
        out = out.filter(
          (g) =>
            ((g._sum as Row).costUsd as number | null) !== null &&
            ((g._sum as Row).costUsd as number) > min
        );
      }
      if (args.orderBy) {
        out.sort(
          (a, b) =>
            (((b._sum as Row).costUsd as number) ?? 0) - (((a._sum as Row).costUsd as number) ?? 0)
        );
      }
      return typeof args.take === 'number' ? out.slice(0, args.take) : out;
    },
  };
}

interface Fixture {
  traces: Row[];
  rollups: Row[];
  runs: Row[];
}

function newFake(f: Fixture, memberships: { team: Row[]; org: Row[] }, users: Row[]) {
  const fake: Record<string, unknown> = {
    agentTrace: table(f.traces),
    agentTraceDailyUsage: table(f.rollups),
    organization: { findMany: async () => [] },
    organizationMembership: {
      findMany: async (a: Row) => memberships.org.filter((m) => matches(m, a.where as Row)),
      findUnique: async (a: { where: { userId_orgId: Row } }) =>
        memberships.org.find(
          (m) => m.userId === a.where.userId_orgId.userId && m.orgId === a.where.userId_orgId.orgId
        ) ?? null,
    },
    team: { findMany: async () => [] },
    teamMembership: {
      findMany: async (a: { where: Row }) => {
        const { team, ...rest } = a.where as { team?: { orgId: string } } & Row;
        return memberships.team.filter(
          (m) => matches(m, rest) && (!team || (m.teamOrgId as string | undefined) === team.orgId)
        );
      },
      findUnique: async (a: { where: { userId_teamId: Row } }) =>
        memberships.team.find(
          (m) =>
            m.userId === a.where.userId_teamId.userId && m.teamId === a.where.userId_teamId.teamId
        ) ?? null,
    },
    user: { findMany: async (a: Row) => users.filter((u) => matches(u, a.where as Row)) },
    workflowRun: {
      findMany: async (a: Row) =>
        f.runs
          .filter((r) => matches(r, a.where as Row))
          .map((r) => ({
            ...r,
            template: { name: `tpl-${r.id}` },
            workRequest: { externalTicketId: `T-${r.id}` },
          })),
    },
  };
  fake.$executeRaw = async () => 0; // the day lock; serialization is tested in shared
  fake.$transaction = async (fn: (tx: unknown) => unknown) => fn(fake);
  return fake;
}

// ── fixture ───────────────────────────────────────────────────────────────────────────────────

let seq = 0;
function trace(over: Row): Row {
  seq += 1;
  return {
    agentKey: 'implementer',
    costUsd: 0.1,
    createdAt: new Date(day(-5) + 3_600_000),
    durationMs: 1000,
    error: null,
    id: `t${seq}`,
    inputTokens: 100,
    model: 'anthropic/claude-sonnet-5-5',
    nodeId: 'executeImplementation',
    orgId: ORG_1,
    outputTokens: 10,
    runId: null,
    teamId: TEAM_A,
    temporalRunId: null,
    type: 'llm_response',
    ...over,
  };
}

function buildFixture(): Fixture {
  const traces: Row[] = [];
  const at = (d: number, h: number) => new Date(day(d) + h * 3_600_000);
  for (let d = -12; d <= 0; d++) {
    // Priced calls across two teams / orgs, two models, run-backed and runless.
    traces.push(
      trace({ costUsd: 0.123457, createdAt: at(d, 1), runId: RUN_1, temporalRunId: 'tr-1' }),
      trace({
        costUsd: 0.2,
        createdAt: at(d, 5),
        durationMs: 2500,
        runId: RUN_1,
        temporalRunId: 'tr-1',
      }),
      trace({
        costUsd: 0.05,
        createdAt: at(d, 9),
        durationMs: 30_000,
        error: 'timeout',
        runId: RUN_1,
        temporalRunId: 'tr-1',
      }),
      trace({
        agentKey: 'reviewer',
        costUsd: 0.31,
        createdAt: at(d, 11),
        model: 'openai/gpt-6.1-sol',
        nodeId: 'runReviewNetwork',
        orgId: ORG_2,
        runId: RUN_2,
        teamId: TEAM_B,
        temporalRunId: 'tr-2',
      }),
      // an unpriced model: tokens, no cost; null duration
      trace({
        costUsd: null,
        createdAt: at(d, 13),
        durationMs: null,
        model: null,
        orgId: ORG_2,
        runId: RUN_2,
        teamId: TEAM_B,
        temporalRunId: 'tr-2',
      }),
      // runless (authoring/eval) spend with no team
      trace({
        agentKey: 'workflowAuthor',
        costUsd: 0.07,
        createdAt: at(d, 15),
        nodeId: 'generateWorkflow',
        orgId: null,
        teamId: null,
      }),
      // a re-started workflow id: the run row belongs to a different Temporal execution
      trace({ costUsd: 0.4, createdAt: at(d, 17), runId: RUN_REUSED, temporalRunId: 'tr-old' }),
      // a tool call is not an LLM call and must not count
      trace({ createdAt: at(d, 19), type: 'tool_call' })
    );
    if (d % 3 === 0) {
      traces.push(
        trace({ costUsd: 1.5, createdAt: at(d, 21), runId: RUN_3, temporalRunId: 'tr-3' })
      );
    }
  }
  // Midnight edges of a completed day.
  traces.push(trace({ costUsd: 0.01, createdAt: new Date(day(-4)) }));
  traces.push(trace({ costUsd: 0.02, createdAt: new Date(day(-3) - 1) }));
  const runs: Row[] = [
    {
      id: RUN_1,
      launchedById: U_ALICE,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: 'tr-1',
    },
    {
      id: RUN_2,
      launchedById: U_BOB,
      startedAt: new Date(day(-12)),
      status: 'FAILED',
      temporalRunId: 'tr-2',
    },
    {
      id: RUN_3,
      launchedById: U_CARL,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: 'tr-3',
    },
    {
      id: RUN_REUSED,
      launchedById: U_ALICE,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: 'tr-new',
    },
  ];
  return { rollups: [], runs, traces };
}

const USERS = [
  { email: 'alice@example.com', id: U_ALICE, name: 'Alice' },
  { email: 'bob@example.com', id: U_BOB, name: 'Bob' },
  { email: 'carl@example.com', id: U_CARL, name: 'Carl' },
];

async function build(
  f: Fixture,
  who: { role: 'ADMIN' | 'LEAD' | 'ENGINEER'; sub?: string } = { role: 'ADMIN' },
  memberships = { org: [] as Row[], team: [] as Row[] }
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newFake(f, memberships, USERS);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: who.role,
      sub: who.sub ?? 'viewer',
    }),
  } as unknown as never);
  await app.register(usageRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };

async function rollUpCompletedDays(_f: Fixture, prisma: unknown, from: number, to: number) {
  for (let d = from; d <= to; d++) {
    await rollupUsageDay(prisma as never, day(d));
  }
}

/** Canonical form: arrays that the report orders only by cost are put in a stable order. */
function canon(data: Record<string, unknown>): unknown {
  const sorted = (v: unknown, key: string) =>
    [...(v as Row[])].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  return JSON.parse(
    JSON.stringify({
      ...data,
      byActivity: sorted(data.byActivity, 'nodeId'),
      byAgent: sorted(data.byAgent, 'agentKey'),
      byModel: sorted(data.byModel, 'model'),
      byOrg: sorted(data.byOrg, 'orgId'),
      byTeam: sorted(data.byTeam, 'teamId'),
      byUser: sorted(data.byUser, 'userId'),
    })
  );
}

/** Deep equality in which numbers agree to 1e-9: floating-point sums, not a rounding step. */
function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThan(1e-9);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual.length, path).toBe(expected.length);
    for (const [i, e] of expected.entries()) {
      expectClose(actual[i], e, `${path}[${i}]`);
    }
  } else if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    expect(Object.keys(actual).sort(), path).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      expectClose((actual as Row)[k], (expected as Row)[k], `${path}.${k}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

async function report(app: Awaited<ReturnType<typeof build>>['app'], qs = 'window=30') {
  const res = await app.inject({
    headers: AUTH,
    method: 'GET',
    url: `/api/v1/platform/usage?${qs}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

describe('usage report: rollup path equals live path', () => {
  it('reproduces every figure of the live report from rollups, for 7, 30 and 90 days', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    for (const window of [7, 30, 90]) {
      const live = await report(app, `window=${window}`);
      f.rollups.length = 0;
      await rollUpCompletedDays(f, prisma, -12, -1);
      const rolled = await report(app, `window=${window}`);
      expectClose(canon(rolled), canon(live));
      // Not vacuous: the second report really did read the rollup.
      expect(f.rollups.length).toBeGreaterThan(0);
      f.rollups.length = 0;
    }
  });

  it('actually reads the rollup for settled days, and the traces for the trailing days', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    const live = await report(app);
    await rollUpCompletedDays(f, prisma, -12, -1);

    // Corrupt a settled day's rollup: the report must show it (it reads the rollup there).
    const settled = f.rollups.find((r) => ms(r.day) === day(-6) && r.agentKey === 'reviewer');
    expect(settled).toBeDefined();
    (settled as Row).calls = ((settled as Row).calls as number) + 1000;
    const tampered = await report(app);
    expect((tampered.totals as Row).calls).toBe(((live.totals as Row).calls as number) + 1000);

    // Corrupt the rollup of a day inside the trailing two (yesterday): the report ignores it.
    (settled as Row).calls = ((settled as Row).calls as number) - 1000;
    for (const r of f.rollups.filter((x) => ms(x.day) === day(-1))) {
      r.calls = 99999;
    }
    expectClose(canon(await report(app)), canon(live));
  });

  it('reads a day with no rollup from the traces, so a sweep that has not run changes nothing', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    const live = await report(app);
    // Only some settled days rolled up: a gap in the middle and the oldest days missing.
    for (const d of [-9, -8, -7, -5, -4]) {
      await rollupUsageDay(prisma as never, day(d));
    }
    expectClose(canon(await report(app)), canon(live));
  });

  it('picks up a trace that arrives after its day was rolled up, while the day is still recomputed', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    await rollUpCompletedDays(f, prisma, -12, -1);
    // A late write into day -2, inside the horizon the sweep still rewrites.
    f.traces.push(trace({ costUsd: 5, createdAt: new Date(day(-2) + 7_200_000) }));
    const before = await report(app);
    const live = await (async () => {
      f.rollups.length = 0;
      return report(app);
    })();
    expectClose(canon(before), canon(live));
  });

  it('is idempotent: recomputing a day twice leaves one set of rows', async () => {
    const f = buildFixture();
    const { prisma } = await build(f);
    await rollupUsageDay(prisma as never, day(-5));
    const first = f.rollups.length;
    await rollupUsageDay(prisma as never, day(-5));
    expect(f.rollups).toHaveLength(first);
    expect(first).toBeGreaterThan(0);
  });

  it('rolls a day with no LLM calls up to no rows', async () => {
    const f = buildFixture();
    f.traces = [];
    const { prisma } = await build(f);
    const r = await rollupUsageDay(prisma as never, day(-5));
    expect(r.rows).toBe(0);
  });

  it('serves a custom range and a team scope the same either way', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    const qs = `since=2026-10-08&until=2026-10-18&teamId=${TEAM_B}`;
    const live = await report(app, qs);
    await rollUpCompletedDays(f, prisma, -12, -1);
    expectClose(canon(await report(app, qs)), canon(live));
    const orgQs = `orgId=${ORG_1}&window=30`;
    f.rollups.length = 0;
    const liveOrg = await report(app, orgQs);
    await rollUpCompletedDays(f, prisma, -12, -1);
    expectClose(canon(await report(app, orgQs)), canon(liveOrg));
  });
});

describe('top runs across both sources', () => {
  it('finds a run that ranks 101st in the live traces and in the rollup but first by the two added', async () => {
    const f = buildFixture();
    f.traces = [];
    const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const X = runId(9999);
    f.runs = [X, ...Array.from({ length: 200 }, (_, i) => runId(i))].map((id) => ({
      id,
      launchedById: null,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: null,
    }));
    // 100 runs of $1.00 only in the live days, 100 only in settled days, X $0.99 in each.
    for (let i = 0; i < 100; i++) {
      f.traces.push(
        trace({ costUsd: 1, createdAt: new Date(day(-1) + 3_600_000), runId: runId(i) })
      );
      f.traces.push(
        trace({ costUsd: 1, createdAt: new Date(day(-6) + 3_600_000), runId: runId(100 + i) })
      );
    }
    f.traces.push(trace({ costUsd: 0.99, createdAt: new Date(day(-1) + 7_200_000), runId: X }));
    f.traces.push(trace({ costUsd: 0.99, createdAt: new Date(day(-6) + 7_200_000), runId: X }));
    const { app, prisma } = await build(f);
    const live = await report(app);
    await rollUpCompletedDays(f, prisma, -12, -1);
    const rolled = await report(app);
    expect(f.rollups.length).toBeGreaterThan(0);
    expect((live.topRuns as Row[])[0]?.runId).toBe(X);
    // Runs tied at $1.00 may come in any order; everything else must match exactly.
    const costs = (d: Row) => (d.topRuns as Row[]).map((r) => r.costUsd);
    expectClose(costs(rolled), costs(live));
    expectClose(canon({ ...rolled, topRuns: [] }), canon({ ...live, topRuns: [] }));
    expect((rolled.topRuns as Row[])[0]).toMatchObject({ costUsd: 1.98, runId: X });
  });

  it('does not let deleted runs hide a run that beats the lists’ floors', async () => {
    const f = buildFixture();
    f.traces = [];
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const X = id(9000);
    const deleted = Array.from({ length: 5 }, (_, i) => id(1000 + i));
    const rich = Array.from({ length: 5 }, (_, i) => id(2000 + i));
    const rollupOnly = Array.from({ length: 90 }, (_, i) => id(3000 + i));
    const liveOnly = Array.from({ length: 100 }, (_, i) => id(4000 + i));
    const exists = [X, ...rich, ...rollupOnly, ...liveOnly];
    f.runs = exists.map((rid) => ({
      id: rid,
      launchedById: null,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: null,
    }));
    const settled = (runId: string, costUsd: number) =>
      f.traces.push(trace({ costUsd, createdAt: new Date(day(-6) + 3_600_000), runId }));
    const current = (runId: string, costUsd: number) =>
      f.traces.push(trace({ costUsd, createdAt: new Date(day(-1) + 3_600_000), runId }));
    for (const r of deleted) {
      settled(r, 100);
    }
    for (const r of rich) {
      settled(r, 50);
    }
    for (const r of rollupOnly) {
      settled(r, 3);
    }
    for (const r of liveOnly) {
      current(r, 2);
    }
    current(X, 1.9);
    settled(X, 2.9);
    const { app, prisma } = await build(f);
    await rollUpCompletedDays(f, prisma, -12, -1);
    // The five $100 runs are gone; their rollup rows are not.
    const data = await report(app);
    const ranking = (data.topRuns as Row[]).map((r) => r.runId);
    expect(ranking.slice(0, 5).sort()).toEqual([...rich].sort());
    expect(ranking[5]).toBe(X);
    expect((data.topRuns as Row[])[5]?.costUsd).toBeCloseTo(4.8, 9);
    expect(ranking).toHaveLength(10);
  });

  it('drops a run that no longer exists before cutting the list to ten', async () => {
    const f = buildFixture();
    f.traces = [];
    const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // Twelve runs; the five costliest were deleted since the day was rolled up.
    f.runs = Array.from({ length: 12 }, (_, i) => runId(i)).map((id) => ({
      id,
      launchedById: null,
      startedAt: new Date(day(-12)),
      status: 'SUCCESS',
      temporalRunId: null,
    }));
    for (let i = 0; i < 12; i++) {
      f.traces.push(
        trace({ costUsd: 12 - i, createdAt: new Date(day(-6) + 3_600_000), runId: runId(i) })
      );
    }
    const { app, prisma } = await build(f);
    await rollUpCompletedDays(f, prisma, -12, -1);
    f.runs.splice(0, 5);
    f.traces = [];
    const data = await report(app);
    expect((data.topRuns as Row[]).map((r) => r.runId)).toEqual(
      Array.from({ length: 7 }, (_, i) => runId(i + 5))
    );
  });
});

describe('launcher attribution', () => {
  it('attributes a trace to the run launcher only when the Temporal run ids match', async () => {
    const f = buildFixture();
    const { prisma } = await build(f);
    await rollupUsageDay(prisma as never, day(-5));
    const byRun = (runId: string) => f.rollups.filter((r) => r.runId === runId);
    expect(byRun(RUN_1).every((r) => r.launcherId === U_ALICE)).toBe(true);
    expect(byRun(RUN_2).every((r) => r.launcherId === U_BOB)).toBe(true);
    // The run row was written by another execution: not Alice's spend.
    expect(byRun(RUN_REUSED).every((r) => r.launcherId === null)).toBe(true);
    // Runless spend has no launcher.
    expect(f.rollups.filter((r) => r.runId === null).every((r) => r.launcherId === null)).toBe(
      true
    );
  });

  it('gives the same byUser from rollups as from the traces', async () => {
    const f = buildFixture();
    const { app, prisma } = await build(f);
    const live = await report(app);
    await rollUpCompletedDays(f, prisma, -12, -1);
    const rolled = await report(app);
    expectClose(canon({ ...rolled }), canon({ ...live }));
    const alice = (rolled.byUser as Row[]).find((u) => u.userId === U_ALICE);
    expect(alice).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
    const bob = (rolled.byUser as Row[]).find((u) => u.userId === U_BOB);
    expect(bob).toBeDefined();
  });
});

describe('byUser visibility', () => {
  it('shows an ADMIN every launcher with name and email', async () => {
    const f = buildFixture();
    const { app } = await build(f);
    const data = await report(app);
    const byUser = data.byUser as Row[];
    expect(byUser.map((u) => u.userId).sort()).toEqual([U_ALICE, U_BOB, U_CARL].sort());
    expect(byUser.every((u) => typeof u.email === 'string' && u.outsideScope === false)).toBe(true);
  });

  it("shows a team LEAD only their team's launchers, by name, and folds the rest into one unnamed row", async () => {
    const f = buildFixture();
    const { app } = await build(
      f,
      { role: 'ENGINEER', sub: 'lead-1' },
      {
        org: [],
        team: [
          { role: 'LEAD', teamId: TEAM_A, userId: 'lead-1' },
          { role: 'ENGINEER', teamId: TEAM_A, userId: U_ALICE },
        ],
      }
    );
    const data = await report(app, `teamId=${TEAM_A}&window=30`);
    const byUser = data.byUser as Row[];
    const alice = byUser.find((u) => u.userId === U_ALICE);
    expect(alice).toMatchObject({ email: null, name: 'Alice', outsideScope: false });
    const outside = byUser.filter((u) => u.outsideScope);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ email: null, name: null, userId: null });
    // Nobody else is named, and no email appears anywhere.
    expect(byUser.filter((u) => u.userId !== null).map((u) => u.userId)).toEqual([U_ALICE]);
    expect(JSON.stringify(byUser)).not.toContain('@example.com');
    expect(JSON.stringify(byUser)).not.toContain('Bob');
  });

  it('shows an ORG_ADMIN the launchers of their organization, by name', async () => {
    const f = buildFixture();
    const { app } = await build(
      f,
      { role: 'ENGINEER', sub: 'oa-1' },
      {
        org: [
          { orgId: ORG_1, role: 'ORG_ADMIN', userId: 'oa-1' },
          { orgId: ORG_1, role: 'ORG_MEMBER', userId: U_ALICE },
        ],
        team: [{ role: 'ENGINEER', teamId: TEAM_B, teamOrgId: ORG_1, userId: U_CARL }],
      }
    );
    const data = await report(app, `orgId=${ORG_1}&window=30`);
    const named = (data.byUser as Row[]).filter((u) => u.userId !== null);
    expect(named.map((u) => u.userId).sort()).toEqual([U_ALICE, U_CARL].sort());
    expect(named.every((u) => u.email === null)).toBe(true);
  });
});
