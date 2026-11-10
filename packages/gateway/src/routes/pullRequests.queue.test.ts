import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveGitHubBaseUrl: vi.fn(async () => 'https://github.com'),
}));

const settings = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));
vi.mock('@auto-swe/shared/config', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: vi.fn(async (key: string) => settings.values[key]),
  resolveSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, settings.values[k]]))
  ),
}));

import { pullRequestRoutes } from './pullRequests.js';

const AUTH = { authorization: 'Bearer fake' };
const REPO = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-00000000000b';

const ROUTING = {
  'prEvaluation.humanAboveLines': 0,
  'prEvaluation.humanMinRisk': 'LOW',
  'prEvaluation.humanPaths': [],
  'prEvaluation.humanSkipsBotApproved': true,
  'prEvaluation.quickReviewMaxLines': 100,
};

const repository = {
  githubUrl: 'https://github.com/acme/api',
  id: REPO,
  organizationName: 'acme',
  repoName: 'api',
  reviewRouting: null,
  team: { orgId: null },
  teamId: TEAM,
};

const pull = (n: number, over: Record<string, unknown> = {}) => ({
  ciStatus: 'PASSED',
  closedAt: null,
  headSha: `sha${n}`,
  id: `pr-${n}`,
  isDraft: false,
  mergedAt: null,
  openedAt: new Date(`2026-11-0${n}T00:00:00Z`),
  prNumber: n,
  repoId: REPO,
  repository,
  reviewVisits: [],
  run: { attributedTeamId: TEAM },
  status: 'OPEN',
  title: `PR ${n}`,
  workflow: null,
  ...over,
});

const evaluation = (n: number, over: Record<string, unknown> = {}) => ({
  autoMergeEnabled: false,
  botApproved: false,
  changedLines: 20,
  connectionId: REPO,
  headSha: `sha${n}`,
  prNumber: n,
  requiredApprovers: 1,
  riskClass: 'LOW',
  trustedApprovers: 0,
  ...over,
});

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, _r, reply) =>
    reply
      .status(error.statusCode ?? 500)
      .send({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } })
  );
  const prisma = {
    prEvaluation: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    team: {
      findFirst: vi.fn().mockResolvedValue({ id: TEAM }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'user-1' }),
  } as unknown as never);
  await app.register(pullRequestRoutes, { prefix: '/api/v1/pull-requests' });
  await app.ready();
  return { app, prisma };
}

describe('GET /api/v1/pull-requests order=attention', () => {
  beforeEach(() => {
    settings.values = { ...ROUTING };
  });

  it('orders the open queue by batch and labels why each needs a person', async () => {
    const b = await buildApp();
    const open = [pull(1), pull(2), pull(3), pull(4, { isDraft: true })];
    // The light read and the page read both go through findMany.
    b.prisma.pullRequest.findMany.mockImplementation(async (args: { where: { id?: unknown } }) =>
      args.where.id ? open : open
    );
    b.prisma.prEvaluation.findMany.mockResolvedValue([
      evaluation(1, { changedLines: 30 }),
      evaluation(2, { changedLines: 900, riskClass: 'HIGH' }),
      // PR 3 has no evaluation at its head.
      evaluation(4),
    ]);
    const res = await b.app.inject({
      headers: AUTH,
      url: '/api/v1/pull-requests?order=attention&state=OPEN',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(
      body.data.map((r: { id: string; review: { batch: string; position: number } }) => [
        r.id,
        r.review.batch,
        r.review.position,
      ])
    ).toEqual([
      // Unevaluated reads as the highest risk, the same rank as HIGH; the longer wait first.
      ['pr-2', 'deep', 1],
      ['pr-3', 'deep', 2],
      ['pr-1', 'quick', 3],
      ['pr-4', 'none', 4],
    ]);
    expect(body.data[1].review).toMatchObject({ needsHuman: true, reason: 'not_evaluated' });
    expect(body.data[3].review).toMatchObject({ needsHuman: false, reason: 'draft' });
    expect(body.meta.queue).toMatchObject({
      batches: { deep: 2, none: 1, quick: 1, standard: 0 },
      capped: false,
      needsHuman: 3,
      open: 4,
    });
    expect(body.meta.total).toBe(4);
    // Only open pull requests are ordered, inside the same visibility filter.
    const where = b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND;
    expect(where).toContainEqual({ status: 'OPEN' });
  });

  it('applies the repository routing: an always-human path and a higher minimum risk', async () => {
    const b = await buildApp();
    settings.values = { ...ROUTING, 'prEvaluation.humanMinRisk': 'HIGH' };
    const overridden = { ...repository, reviewRouting: { humanPaths: ['src/pay/**'] } };
    b.prisma.pullRequest.findMany.mockResolvedValue([
      pull(1, { repository: overridden }),
      pull(2, { repository: overridden }),
    ]);
    b.prisma.prEvaluation.findMany.mockResolvedValue([
      { ...evaluation(1), brief: { path: [{ flagged: false, path: 'src/pay/charge.ts' }] } },
      { ...evaluation(2), brief: { path: [{ flagged: false, path: 'src/other.ts' }] } },
    ]);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests?order=attention' });
    const byId = Object.fromEntries(
      res.json().data.map((r: { id: string; review: unknown }) => [r.id, r.review])
    );
    expect(byId['pr-1']).toMatchObject({
      matchedPath: 'src/pay/charge.ts',
      needsHuman: true,
      reason: 'path',
    });
    expect(byId['pr-2']).toMatchObject({ needsHuman: false, reason: 'below_threshold' });
  });

  it('answers 400 for a state other than open', async () => {
    const b = await buildApp();
    const res = await b.app.inject({
      headers: AUTH,
      url: '/api/v1/pull-requests?order=attention&state=MERGED',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ATTENTION_ORDER_OPEN_ONLY');
  });

  it('keeps the newest-first order by default and labels its rows without a position', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findMany.mockResolvedValue([pull(2), pull(1)]);
    b.prisma.pullRequest.count.mockResolvedValue(2);
    b.prisma.prEvaluation.findMany.mockResolvedValue([evaluation(1), evaluation(2)]);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests' });
    const body = res.json();
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(['pr-2', 'pr-1']);
    expect(body.data[0].review).toMatchObject({ batch: 'quick', position: null });
    expect(body.meta.queue).toBeUndefined();
  });
});

describe('GET /api/v1/pull-requests/review-time', () => {
  beforeEach(() => {
    settings.values = { ...ROUTING };
  });

  it('reports reviewer time per repository and per team, and the open queue', async () => {
    const b = await buildApp();
    const merged = pull(1, {
      mergedAt: new Date('2026-11-01T10:00:00Z'),
      reviewVisits: [{ firstVisitedAt: new Date('2026-11-01T00:30:00Z') }],
      status: 'MERGED',
    });
    b.prisma.pullRequest.findMany.mockImplementation(
      async (args: { select: Record<string, unknown> }) =>
        // The cohort read selects reviewVisits; the queue read selects the routing repository.
        'reviewVisits' in args.select ? [merged, pull(2)] : [pull(3)]
    );
    b.prisma.prEvaluation.findMany.mockImplementation(
      async (args: { select: Record<string, unknown> }) =>
        'firstHumanReviewAt' in args.select
          ? [
              {
                changesRequestedCount: 1,
                connectionId: REPO,
                createdAt: new Date('2026-11-01T00:00:00Z'),
                firstHumanReviewAt: new Date('2026-11-01T02:00:00Z'),
                headSha: 'sha1',
                prNumber: 1,
                triggeredBy: 'pull_request.opened',
              },
            ]
          : [evaluation(3)]
    );
    b.prisma.team.findMany.mockResolvedValue([{ id: TEAM, name: 'Payments' }]);
    const res = await b.app.inject({
      headers: AUTH,
      url: `/api/v1/pull-requests/review-time?window=365&teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.overall).toMatchObject({
      changeRequestRate: 1,
      lowSample: true,
      pullRequests: 2,
      reviewed: 1,
      reviewToMerge: { count: 1, p50: 8 * 3_600_000 },
      timeToFirstReview: { count: 1, p50: 2 * 3_600_000 },
      timeToFirstView: { count: 1, p50: 30 * 60_000 },
      unmeasured: 1,
    });
    expect(data.byRepository[0]).toMatchObject({ repository: { name: 'api', org: 'acme' } });
    expect(data.byTeam).toEqual([expect.objectContaining({ teamId: TEAM, teamName: 'Payments' })]);
    expect(data.queue).toMatchObject({ needsHuman: 1, open: 1 });
    // Drafts have not asked for review, so they are outside the cohort.
    const cohortWhere = b.prisma.pullRequest.findMany.mock.calls.find(
      (call) => 'reviewVisits' in call[0].select
    )?.[0].where.AND;
    expect(cohortWhere).toContainEqual({ isDraft: false });
  });
});
