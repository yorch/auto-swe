import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GATE = { mode: 'off', staleAfterHours: 0 } as const;
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));

import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestRoutes } from './pullRequests.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Mid-day, so the default 30-day window is [2026-05-17T00:00Z, 2026-06-16T00:00Z)
// and the previous one starts 2026-04-17T00:00Z.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const WINDOW_START = new Date('2026-05-17T00:00:00.000Z');
const WINDOW_END = new Date('2026-06-16T00:00:00.000Z');
const PREVIOUS_START = new Date('2026-04-17T00:00:00.000Z');
const AUTH = { authorization: 'Bearer fake' };
const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';

type Role = 'ADMIN' | 'ENGINEER' | 'VIEWER';

function repo(n: number) {
  return { id: `repo-${n}`, organizationName: 'acme', repoName: `r${n}` };
}

function pr(openedAt: Date, over: Record<string, unknown> = {}) {
  return {
    ciStatus: 'PASSED',
    isDraft: false,
    mergedAt: null,
    openedAt,
    repoId: UUID_A,
    repository: repo(1),
    status: 'OPEN',
    workflow: null,
    ...over,
  };
}
/** Opened a day into the current window (plus `offsetMs`). */
const inCurrent = (offsetMs = 0, over: Record<string, unknown> = {}) =>
  pr(new Date(WINDOW_START.getTime() + DAY_MS + offsetMs), over);
/** Opened a day before the current window (minus `offsetMs`). */
const inPrevious = (offsetMs = 0, over: Record<string, unknown> = {}) =>
  pr(new Date(WINDOW_START.getTime() - DAY_MS - offsetMs), over);

async function buildApp(role: Role = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    activeWorkflow: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
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
  b.app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/pull-requests/outcomes${query}` });
const whereOf = (b: Built) =>
  b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND as unknown[];

describe('GET /api/v1/pull-requests/outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('splits the cohort into current and previous and reports the window', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      inCurrent(0, {
        mergedAt: new Date(WINDOW_START.getTime() + DAY_MS + 3_600_000),
        status: 'MERGED',
      }),
      inCurrent(1000, { status: 'CLOSED' }),
      inPrevious(0, { mergedAt: new Date(WINDOW_START.getTime() - DAY_MS + 1), status: 'MERGED' }),
    ]);
    const { data } = (await get(b)).json();
    expect(data.window).toEqual({
      days: 30,
      end: WINDOW_END.toISOString(),
      start: WINDOW_START.toISOString(),
    });
    expect(data.current).toMatchObject({ closedUnmerged: 1, merged: 1, mergeRate: 0.5, opened: 2 });
    expect(data.current.timeToMergeMs.count).toBe(1);
    expect(data.previous).toMatchObject({ merged: 1, mergeRate: 1, opened: 1 });
    expect(data.previousComplete).toBe(true);
    expect(data.isTruncated).toBe(false);
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].take).toBe(10_001);
  });

  it('puts a PR opened exactly at the window start in the current window', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      pr(WINDOW_START),
      pr(new Date(WINDOW_START.getTime() - 1)),
    ]);
    const { data } = (await get(b)).json();
    expect(data.current.opened).toBe(1);
    expect(data.previous.opened).toBe(1);
  });

  it('attributes PRs by workflow run and filters the cohort by template', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      inCurrent(0, {
        mergedAt: new Date(WINDOW_START.getTime() + DAY_MS + 3_600_000),
        repoId: UUID_A,
        status: 'MERGED',
        workflow: { repoId: UUID_A, temporalWorkflowId: 'temporal-1' },
      }),
      inCurrent(1000, { status: 'OPEN', workflow: null }),
    ]);
    b.prisma.workflowRun.findMany.mockResolvedValue([
      { template: { name: 'Build' }, templateId: UUID_B, workflowId: 'temporal-1' },
    ]);
    b.prisma.activeWorkflow.findMany.mockResolvedValue([
      { repoId: UUID_A, temporalWorkflowId: 'temporal-1' },
    ]);
    const { data } = (await get(b, `?templateId=${UUID_B}`)).json();
    expect(data.current.opened).toBe(1);
    expect(data.byTemplate).toEqual([
      {
        closedUnmerged: 0,
        medianTimeToMergeMs: 3_600_000,
        merged: 1,
        mergeRate: 1,
        opened: 1,
        templateId: UUID_B,
        templateName: 'Build',
      },
    ]);
    expect(b.prisma.workflowRun.findMany).toHaveBeenCalled();
    expect(whereOf(b)).toContainEqual({
      OR: [
        {
          repoId: UUID_A,
          workflow: { temporalWorkflowId: { in: ['temporal-1'] } },
        },
      ],
    });
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].take).toBe(10_001);
  });

  it('groups repository-consistent attribution links before the capped PR read', async () => {
    const b = await buildApp();
    b.prisma.workflowRun.findMany.mockResolvedValue([
      { template: { name: 'Build' }, templateId: UUID_B, workflowId: 'temporal-1' },
      { template: { name: 'Build' }, templateId: UUID_B, workflowId: 'temporal-2' },
      { template: { name: 'Build' }, templateId: UUID_B, workflowId: 'temporal-3' },
    ]);
    b.prisma.activeWorkflow.findMany.mockResolvedValue([
      { repoId: UUID_A, temporalWorkflowId: 'temporal-1' },
      { repoId: UUID_A, temporalWorkflowId: 'temporal-2' },
      { repoId: UUID_B, temporalWorkflowId: 'temporal-3' },
    ]);

    await get(b, `?templateId=${UUID_B}`);

    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 10_001,
      where: {
        AND: expect.arrayContaining([
          {
            OR: [
              {
                repoId: UUID_A,
                workflow: {
                  temporalWorkflowId: { in: ['temporal-1', 'temporal-2'] },
                },
              },
              {
                repoId: UUID_B,
                workflow: { temporalWorkflowId: { in: ['temporal-3'] } },
              },
            ],
          },
        ]),
      },
    });
  });

  it('places PRs without a visible workflow run in the unattributed template bucket', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      inCurrent(0, {
        repoId: UUID_A,
        workflow: { repoId: UUID_A, temporalWorkflowId: 'not-visible' },
      }),
    ]);
    const { data } = (await get(b)).json();
    expect(data.byTemplate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opened: 1,
          templateId: null,
          templateName: 'Unattributed',
        }),
      ])
    );
  });

  it('bounds openedAt to [previousStart, end) and adds no repository filter for an admin', async () => {
    const b = await buildApp('ADMIN');
    await get(b);
    expect(whereOf(b)).toEqual([{}, { openedAt: { gte: PREVIOUS_START, lt: WINDOW_END } }]);
  });

  it('adds the reachable-repository filter for a non-admin', async () => {
    const b = await buildApp('ENGINEER');
    await get(b);
    expect(whereOf(b)).toEqual([
      { repository: reachableConnections({ sub: 'user-1' }, GATE) },
      { openedAt: { gte: PREVIOUS_START, lt: WINDOW_END } },
    ]);
  });

  it('adds the repoId, team (with shares) and MINE filters', async () => {
    const b = await buildApp('ENGINEER');
    await get(b, `?repoId=${UUID_A}&teamId=${UUID_B}&scope=MINE`);
    expect(whereOf(b).slice(2)).toEqual([
      { repoId: UUID_A },
      { repository: { OR: [{ teamId: UUID_B }, { shares: { some: { teamId: UUID_B } } }] } },
      { workflow: { workRequest: { requestedById: 'user-1' } } },
    ]);
  });

  it('defaults scope to TEAM: no requester filter', async () => {
    const b = await buildApp('ENGINEER');
    await get(b);
    expect(JSON.stringify(whereOf(b))).not.toContain('requestedById');
  });

  it('uses a custom since/until range and its previous period', async () => {
    const b = await buildApp();
    const res = await get(b, '?since=2026-06-01&until=2026-06-10');
    expect(res.json().data.window).toEqual({
      days: 10,
      end: '2026-06-11T00:00:00.000Z',
      start: '2026-06-01T00:00:00.000Z',
    });
    expect(whereOf(b)[1]).toEqual({
      openedAt: {
        gte: new Date('2026-05-22T00:00:00.000Z'),
        lt: new Date('2026-06-11T00:00:00.000Z'),
      },
    });
  });

  it('rejects a bad range or window with 400', async () => {
    const b = await buildApp();
    expect((await get(b, '?since=2026-06-10&until=2026-06-01')).statusCode).toBe(400);
    expect((await get(b, '?since=2026-06-01')).statusCode).toBe(400);
    expect((await get(b, '?window=0')).statusCode).toBe(400);
    expect(b.prisma.pullRequest.findMany).not.toHaveBeenCalled();
  });

  it('refuses a VIEWER', async () => {
    const b = await buildApp('VIEWER');
    expect((await get(b)).statusCode).toBe(403);
    expect(b.prisma.pullRequest.findMany).not.toHaveBeenCalled();
  });

  it('ranks the top 10 repositories by PRs opened and drops the rest', async () => {
    const b = await buildApp();
    const rows = [];
    for (let n = 1; n <= 12; n++) {
      // Repo n opens n PRs, so repo-12 leads and repo-1 and repo-2 fall off.
      for (let i = 0; i < n; i++) {
        rows.push(inCurrent(i, { repository: repo(n) }));
      }
    }
    b.prisma.pullRequest.findMany.mockResolvedValue(rows);
    const { data } = (await get(b)).json();
    expect(data.byRepository.map((r: { repository: { id: string } }) => r.repository.id)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `repo-${n}`)
    );
    expect(data.byRepository[0].summary.opened).toBe(12);
    expect(data.byRepository[0].repository).toEqual({ id: 'repo-12', name: 'r12', org: 'acme' });
  });

  it('skips rows with no repository in byRepository but still counts them', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      inCurrent(0, { repository: null }),
      inCurrent(1),
    ]);
    const { data } = (await get(b)).json();
    expect(data.current.opened).toBe(2);
    expect(data.byRepository).toHaveLength(1);
    expect(data.byRepository[0].summary.opened).toBe(1);
  });

  it('is not truncated when exactly 10,000 rows come back', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue(
      Array.from({ length: 10_000 }, (_, i) => inCurrent(i))
    );
    const { data } = (await get(b)).json();
    expect(data.isTruncated).toBe(false);
    expect(data.previousComplete).toBe(true);
    expect(data.previous).toMatchObject({ opened: 0 });
    expect(data.current.opened).toBe(10_000);
  });

  it('is truncated when the row past the cap is in the current window', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue(
      Array.from({ length: 10_001 }, (_, i) => inCurrent(i))
    );
    const { data } = (await get(b)).json();
    expect(data.isTruncated).toBe(true);
    expect(data.previousComplete).toBe(false);
    expect(data.previous).toBeNull();
    expect(data.current.opened).toBe(10_000);
  });

  it('is not truncated when the cap only cuts into the previous window; previous is null', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) => inCurrent(i)),
      ...Array.from({ length: 9_996 }, (_, i) => inPrevious(i)),
    ]);
    const { data } = (await get(b)).json();
    expect(data.isTruncated).toBe(false);
    expect(data.previousComplete).toBe(false);
    expect(data.previous).toBeNull();
  });

  it('is not truncated when the last kept row is in the window but the lost row is not', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([
      ...Array.from({ length: 10_000 }, (_, i) => inCurrent(i)),
      inPrevious(0),
    ]);
    const { data } = (await get(b)).json();
    expect(data.isTruncated).toBe(false);
    expect(data.previous).toBeNull();
  });
});
