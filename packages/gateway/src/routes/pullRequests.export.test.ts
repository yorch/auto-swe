import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));

import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestRoutes } from './pullRequests.js';

const GATE = { mode: 'off', staleAfterHours: 0 } as const;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const WINDOW_START = new Date('2026-05-17T00:00:00.000Z');
const WINDOW_END = new Date('2026-06-16T00:00:00.000Z');
const AUTH = { authorization: 'Bearer fake' };
const BATCH = 500;
const TEAM = '00000000-0000-4000-8000-00000000000b';
const MAX_ROWS = 50_000;

type Role = 'ADMIN' | 'ENGINEER' | 'VIEWER';

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    ciStatus: 'PASSED',
    closedAt: null,
    id: `pr-${String(n).padStart(6, '0')}`,
    isDraft: false,
    mergedAt: null,
    openedAt: new Date(WINDOW_START.getTime() + 86_400_000),
    prNumber: n,
    repository: { organizationName: 'acme', repoName: 'api' },
    status: 'OPEN',
    ...over,
  };
}

async function buildApp(role: Role = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    activeWorkflow: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(pullRequestRoutes, { prefix: '/api/v1/pull-requests' });
  await app.ready();
  return { app, prisma };
}
type Built = Awaited<ReturnType<typeof buildApp>>;

const get = (b: Built, query = '') =>
  b.app.inject({
    headers: AUTH,
    method: 'GET',
    url: `/api/v1/pull-requests/outcomes/export${query}`,
  });

describe('GET /api/v1/pull-requests/outcomes/export', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('writes a header and one CSV row per PR, with the time to merge in milliseconds', async () => {
    const b = await buildApp();
    const opened = new Date('2026-06-01T00:00:00.000Z');
    const merged = new Date('2026-06-01T01:00:00.000Z');
    b.prisma.pullRequest.count.mockResolvedValue(2);
    b.prisma.pullRequest.findMany.mockResolvedValue([
      row(1, { mergedAt: merged, openedAt: opened, status: 'MERGED' }),
      row(2, { isDraft: true, repository: null }),
    ]);
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('pull-request-outcomes.csv');
    expect(res.headers['x-export-row-limit']).toBe(String(MAX_ROWS));
    expect(res.headers['x-export-truncated']).toBe('false');
    const lines = res.body.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'pull_request_id,repository_org,repository_name,pr_number,status,is_draft,ci_status,opened_at,merged_at,closed_at,time_to_merge_ms,template_id,template_name'
    );
    expect(lines[1]).toBe(
      `pr-000001,acme,api,1,MERGED,false,PASSED,${opened.toISOString()},${merged.toISOString()},,3600000,,`
    );
    expect(lines[2]?.startsWith('pr-000002,,,2,OPEN,true,PASSED,')).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it('filters by repository and template and exports attribution', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      row(1, {
        repoId: TEAM,
        workflow: { repoId: TEAM, temporalWorkflowId: 'workflow-1' },
      }),
    ]);
    b.prisma.workflowRun.findMany
      .mockResolvedValueOnce([{ workflowId: 'workflow-1' }])
      .mockResolvedValueOnce([
        { template: { name: 'Build' }, templateId: TEAM, workflowId: 'workflow-1' },
      ]);
    b.prisma.activeWorkflow.findMany.mockResolvedValue([
      { repoId: TEAM, temporalWorkflowId: 'workflow-1' },
    ]);
    const response = await get(b, `?templateId=${TEAM}&repoId=${TEAM}`);
    expect(response.statusCode).toBe(200);
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({
      repoId: TEAM,
    });
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({
      OR: [
        {
          repoId: TEAM,
          workflow: { temporalWorkflowId: { in: ['workflow-1'] } },
        },
      ],
    });
    expect(response.body.trimEnd().split('\n')[1]).toMatch(new RegExp(`,${TEAM},Build$`));
  });

  it('excludes repository-mismatched links from a template-filtered export', async () => {
    const otherRepo = '00000000-0000-4000-8000-00000000000c';
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      row(1, {
        repoId: otherRepo,
        workflow: { repoId: TEAM, temporalWorkflowId: 'workflow-1' },
      }),
      row(2, {
        repoId: TEAM,
        workflow: { repoId: TEAM, temporalWorkflowId: 'workflow-1' },
      }),
    ]);
    b.prisma.workflowRun.findMany
      .mockResolvedValueOnce([
        { workflowId: 'workflow-1' },
        { workflowId: 'workflow-2' },
        { workflowId: 'workflow-3' },
      ])
      .mockResolvedValueOnce([
        { template: { name: 'Build' }, templateId: TEAM, workflowId: 'workflow-1' },
        { template: { name: 'Build' }, templateId: TEAM, workflowId: 'workflow-2' },
        { template: { name: 'Build' }, templateId: TEAM, workflowId: 'workflow-3' },
      ]);
    b.prisma.activeWorkflow.findMany.mockResolvedValue([
      { repoId: TEAM, temporalWorkflowId: 'workflow-1' },
      { repoId: TEAM, temporalWorkflowId: 'workflow-2' },
      { repoId: otherRepo, temporalWorkflowId: 'workflow-3' },
    ]);

    const response = await get(b, `?templateId=${TEAM}`);
    expect(response.statusCode).toBe(200);
    const lines = response.body.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`,${TEAM},Build`);
    expect(lines[1]).not.toContain('pr-000001');
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({
      OR: [
        {
          repoId: TEAM,
          workflow: { temporalWorkflowId: { in: ['workflow-1', 'workflow-2'] } },
        },
        {
          repoId: otherRepo,
          workflow: { temporalWorkflowId: { in: ['workflow-3'] } },
        },
      ],
    });
    expect(b.prisma.workflowRun.findMany.mock.calls[0]?.[0].take).toBe(50_001);
    expect(b.prisma.workflowRun.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({
      startedAt: {
        gte: new Date(WINDOW_START.getTime() - 30 * 24 * 60 * 60 * 1000),
        lt: WINDOW_END,
      },
    });
  });

  it('defuses a spreadsheet formula in a text cell', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      row(1, { repository: { organizationName: '=cmd|calc', repoName: '-x' } }),
    ]);
    const body = (await get(b)).body;
    expect(body).toContain("'=cmd|calc,'-x,");
  });

  it('streams NDJSON with the same fields when asked', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([row(1), row(2)]);
    const res = await get(b, '?format=ndjson');
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('pull-request-outcomes.ndjson');
    const rows = res.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      is_draft: false,
      pr_number: 1,
      pull_request_id: 'pr-000001',
      repository_name: 'api',
      time_to_merge_ms: null,
    });
  });

  it('covers only the current window and applies the same visibility as the summary', async () => {
    const admin = await buildApp('ADMIN');
    await get(admin);
    const adminWhere = admin.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND;
    expect(adminWhere).toEqual([{}, { openedAt: { gte: WINDOW_START, lt: WINDOW_END } }]);
    expect(admin.prisma.pullRequest.count.mock.calls[0]?.[0].where.AND).toEqual(adminWhere);

    const engineer = await buildApp('ENGINEER');
    await get(engineer, `?scope=MINE&repoId=00000000-0000-4000-8000-00000000000a`);
    expect(engineer.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND).toEqual([
      { repository: reachableConnections({ sub: 'user-1' }, GATE) },
      { openedAt: { gte: WINDOW_START, lt: WINDOW_END } },
      { repoId: '00000000-0000-4000-8000-00000000000a' },
      { workflow: { workRequest: { requestedById: 'user-1' } } },
    ]);
  });

  it('refuses a VIEWER and a bad query without reading', async () => {
    const viewer = await buildApp('VIEWER');
    expect((await get(viewer)).statusCode).toBe(403);
    const b = await buildApp();
    expect((await get(b, '?format=xml')).statusCode).toBe(400);
    expect((await get(b, '?since=2026-06-10')).statusCode).toBe(400);
    expect(viewer.prisma.pullRequest.findMany).not.toHaveBeenCalled();
    expect(b.prisma.pullRequest.findMany).not.toHaveBeenCalled();
  });

  it('stops at the row cap and says the file is cut short', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.count.mockResolvedValue(MAX_ROWS + 1);
    let n = 0;
    b.prisma.pullRequest.findMany.mockImplementation(async () =>
      Array.from({ length: BATCH }, () => row(n++))
    );
    const res = await get(b, '?format=ndjson');
    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.body.trimEnd().split('\n')).toHaveLength(MAX_ROWS);
    // 100 full batches, and no read for a 101st.
    expect(b.prisma.pullRequest.findMany).toHaveBeenCalledTimes(MAX_ROWS / BATCH);
    // Streams 50,000 rows through the HTTP layer: well under a second alone, but real work, so a
    // starved runner gets a larger limit than the 5 s default.
  }, 20_000);

  it('cuts the last batch at the cap when the cap is not on a batch boundary', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.count.mockResolvedValue(MAX_ROWS + 1);
    let n = 0;
    // A batch of 501 does not divide 50,000, so the 100th batch must be sliced to 401 rows.
    b.prisma.pullRequest.findMany.mockImplementation(async () =>
      Array.from({ length: BATCH + 1 }, () => row(n++))
    );
    const res = await get(b, '?format=ndjson');
    const ids = res.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).pull_request_id);
    expect(ids).toHaveLength(MAX_ROWS);
    expect(new Set(ids).size).toBe(MAX_ROWS);
    expect(b.prisma.pullRequest.findMany).toHaveBeenCalledTimes(Math.ceil(MAX_ROWS / (BATCH + 1)));
  }, 20_000);

  it('builds the same filters as /outcomes for the same query, apart from the lower date bound', async () => {
    const query = `?teamId=${TEAM}&repoId=${TEAM}&scope=MINE&since=2026-06-01&until=2026-06-10`;
    const b = await buildApp('ENGINEER');
    await get(b, query);
    await b.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/pull-requests/outcomes${query}`,
    });
    const [exported, summarised] = b.prisma.pullRequest.findMany.mock.calls.map(
      ([arg]) => arg.where.AND as Array<Record<string, unknown>>
    );
    expect(exported).toHaveLength(5);
    expect(exported?.[0]).toEqual(summarised?.[0]);
    expect(exported?.slice(2)).toEqual(summarised?.slice(2));
    // The summary also reads the previous period; both stop at the same end.
    const upperBound = (filters: Array<Record<string, unknown>> | undefined) =>
      (filters?.[1] as { openedAt: { lt: Date } } | undefined)?.openedAt.lt;
    expect(upperBound(exported)).toEqual(upperBound(summarised));
    expect(upperBound(exported)).toBeInstanceOf(Date);
  });

  it('pages with a cursor and stops after a short batch', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany
      .mockResolvedValueOnce(Array.from({ length: BATCH }, (_, i) => row(i)))
      .mockResolvedValueOnce([row(BATCH)]);
    const res = await get(b, '?format=ndjson');
    expect(res.body.trimEnd().split('\n')).toHaveLength(BATCH + 1);
    const second = b.prisma.pullRequest.findMany.mock.calls[1]?.[0];
    expect(second.cursor).toEqual({ id: row(BATCH - 1).id });
    expect(second.skip).toBe(1);
    expect(b.prisma.pullRequest.findMany).toHaveBeenCalledTimes(2);
  });

  it('answers 500 when the database fails before the first byte', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockRejectedValue(new Error('db down'));
    const res = await get(b);
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).not.toContain('pull_request_id');
  });

  it('aborts the transfer, rather than ending it cleanly, when the database fails mid-stream', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.count.mockResolvedValue(BATCH + 1);
    b.prisma.pullRequest.findMany
      .mockResolvedValueOnce(Array.from({ length: BATCH }, (_, i) => row(i)))
      .mockRejectedValueOnce(new Error('db down'));
    // The headers (200) are already sent, so the failure cannot become a status code: the
    // transfer is aborted instead, which a client sees as a failed download, not a short file.
    await expect(get(b, '?format=ndjson')).rejects.toBeDefined();
  });
});
