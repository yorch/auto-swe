import { prisma } from '@auto-swe/shared/db';
import { rollupUsageDay } from '@auto-swe/shared/lib/agentTraceRollup';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageRoutes } from './usage.js';

/**
 * The usage report read from `agent_trace_daily_usage` must equal the report read from
 * `agent_traces`, against real Postgres: the rollup is built with `groupBy` over a Float column
 * into a Decimal one, and BigInt/Decimal sums come back as different JavaScript types than the
 * live Int/Float sums, which the in-memory test in `usage.rollup.test.ts` cannot show.
 *
 * Opt in with `USAGE_ROLLUP_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, and rebuilds whole days of the rollup table, so use a
 * throwaway one). The report is scoped to the fixture team so other rows do not matter.
 */
const enabled = process.env.USAGE_ROLLUP_PG_TEST === '1';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Read per test, never at module load: a run that crosses midnight must not straddle two days. */
const todayMs = () => Math.floor(Date.now() / DAY_MS) * DAY_MS;
const ORG = '7e000000-0000-4000-8000-0000000000a1';
const TEAM = '7e000000-0000-4000-8000-0000000000a2';
const USER = '7e000000-0000-4000-8000-0000000000a3';
const TEMPLATE = '7e000000-0000-4000-8000-0000000000a4';
const PREFIX = 'usage-rollup-pg-';
const MODELS = ['AgentTrace', 'AgentTraceDailyUsage', 'Team', 'WorkflowTemplate'];

const unscoped = <T>(fn: () => Promise<T>) => runUnscoped('test fixture rows', MODELS, fn);

type Row = Record<string, unknown>;

function canon(data: Row): unknown {
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

describe.skipIf(!enabled)('usage rollup against Postgres', () => {
  let app: FastifyInstance;
  const runs: string[] = [];

  const report = async (): Promise<Row> => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: `/api/v1/platform/usage?teamId=${TEAM}&window=30`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  };

  beforeAll(async () => {
    await cleanup();
    await prisma.organization.create({ data: { id: ORG, name: PREFIX, slug: PREFIX } });
    await prisma.team.create({ data: { id: TEAM, name: PREFIX, orgId: ORG, slug: PREFIX } });
    await prisma.user.create({
      data: { email: `${PREFIX}u@example.com`, id: USER, name: 'Rollup U' },
    });
    await unscoped(() =>
      prisma.workflowTemplate.create({ data: { id: TEMPLATE, name: `${PREFIX}template` } })
    );
    for (const [i, temporalRunId] of ['tr-a', 'tr-b'].entries()) {
      const request = await prisma.runInput.create({
        data: { externalTicketId: `${PREFIX}${i}`, requestPayload: '{}' },
      });
      const run = await prisma.workflowRun.create({
        data: {
          launchedById: USER,
          specSnapshot: {},
          templateId: TEMPLATE,
          templateVersion: 1,
          temporalRunId,
          workflowId: `${PREFIX}${i}`,
          workRequestId: request.id,
        },
      });
      runs.push(run.id);
    }
    let seq = 0;
    const today = todayMs();
    // Days -6..0 are this window; day -40 is in the previous 30-day period.
    for (const d of [-40, -6, -5, -4, -3, -2, -1, 0]) {
      const at = (h: number) => new Date(today + d * DAY_MS + h * 3_600_000);
      const base = {
        agentKey: 'implementer',
        nodeId: 'executeImplementation',
        orgId: ORG,
        teamId: TEAM,
        type: 'llm_response',
      };
      const rows = [
        {
          ...base,
          costUsd: 0.1234567,
          createdAt: at(1),
          durationMs: 1200,
          inputTokens: 1000,
          model: 'anthropic/x',
          outputTokens: 100,
          runId: runs[0],
          temporalRunId: 'tr-a',
        },
        {
          ...base,
          costUsd: 0.2,
          createdAt: at(5),
          durationMs: 800,
          error: 'boom',
          inputTokens: 50,
          model: 'anthropic/x',
          outputTokens: 5,
          runId: runs[0],
          temporalRunId: 'tr-a',
        },
        // The run row was written by another Temporal execution: not attributable.
        {
          ...base,
          costUsd: 0.4,
          createdAt: at(9),
          durationMs: 300,
          inputTokens: 10,
          model: 'openai/y',
          outputTokens: 1,
          runId: runs[1],
          temporalRunId: 'tr-other',
        },
        // Unpriced, no duration, no run.
        {
          ...base,
          agentKey: 'workflowAuthor',
          costUsd: null,
          createdAt: at(13),
          durationMs: null,
          inputTokens: 7,
          model: null,
          nodeId: 'generateWorkflow',
          outputTokens: 3,
        },
        { ...base, costUsd: 9, createdAt: at(15), type: 'tool_call' },
      ];
      for (const r of rows) {
        seq += 1;
        await unscoped(() => prisma.agentTrace.create({ data: { ...r, seq } }));
      }
    }
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: USER }),
    } as unknown as never);
    await app.register(usageRoutes, { prefix: '/api/v1/platform' });
    await app.ready();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('reports the same figures from the rollup as from the traces', async () => {
    const today = todayMs();
    await unscoped(() => prisma.agentTraceDailyUsage.deleteMany({ where: { teamId: TEAM } }));
    const live = await report();
    expect((live.totals as Row).calls).toBeGreaterThan(0);
    expect(((live.previous as Row).calls as number) > 0).toBe(true);

    // The sweep rewrites the whole day, every tenant's rows included; that is fine on a throwaway
    // database. Days -40 (previous period) and -6..-3 are settled, so the report reads them from
    // the rollup; -2 and -1 are inside the horizon and are read live whatever the rollup says.
    for (const d of [-40, -6, -5, -4, -3, -2, -1]) {
      await rollupUsageDay(prisma, today + d * DAY_MS);
    }
    const rolled = await report();
    expectClose(canon(rolled), canon(live));

    const stored = await unscoped(() =>
      prisma.agentTraceDailyUsage.count({ where: { teamId: TEAM } })
    );
    expect(stored).toBeGreaterThan(0);
  });

  it('really reads the rollup for settled days, the current and the previous period', async () => {
    const today = todayMs();
    const baseline = await report();
    const bump = async (day: number) => {
      const row = await unscoped(() =>
        prisma.agentTraceDailyUsage.findFirst({ where: { day: new Date(day), teamId: TEAM } })
      );
      expect(row, 'a rollup row for the day').not.toBeNull();
      await unscoped(() =>
        prisma.agentTraceDailyUsage.update({
          data: { calls: { increment: 1000 } },
          where: { id: (row as { id: string }).id },
        })
      );
    };
    await bump(today - 6 * DAY_MS);
    const current = await report();
    expect((current.totals as Row).calls).toBe(((baseline.totals as Row).calls as number) + 1000);
    await bump(today - 40 * DAY_MS);
    const previous = await report();
    expect((previous.previous as Row).calls).toBe(
      ((baseline.previous as Row).calls as number) + 1000
    );
    // Restore: rebuilding the days is the sweep's own repair.
    await rollupUsageDay(prisma, today - 6 * DAY_MS);
    await rollupUsageDay(prisma, today - 40 * DAY_MS);
    expectClose(canon(await report()), canon(baseline));
  });
});

async function cleanup() {
  const rows = await prisma.workflowRun.findMany({
    select: { id: true },
    where: { workflowId: { startsWith: PREFIX } },
  });
  await unscoped(() => prisma.agentTrace.deleteMany({ where: { teamId: TEAM } }));
  await unscoped(() => prisma.agentTraceDailyUsage.deleteMany({ where: { teamId: TEAM } }));
  await prisma.workflowRun.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  await prisma.runInput.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } });
  await unscoped(() => prisma.workflowTemplate.deleteMany({ where: { id: TEMPLATE } }));
  await unscoped(() => prisma.team.deleteMany({ where: { id: TEAM } }));
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
}
