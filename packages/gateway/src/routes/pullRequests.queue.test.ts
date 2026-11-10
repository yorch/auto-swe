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
  'prEvaluation.defaultMode': 'advisory',
  'prEvaluation.enabled': true,
  'prEvaluation.humanAboveLines': 0,
  'prEvaluation.humanMinRisk': 'LOW',
  'prEvaluation.humanPaths': [],
  'prEvaluation.humanSkipsBotApproved': true,
  'prEvaluation.quickReviewMaxLines': 100,
};

const repository = {
  githubUrl: 'https://github.com/acme/api',
  id: REPO,
  isActive: true,
  organizationName: 'acme',
  prEvaluationMode: null,
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
  changesRequestedCount: 0,
  connectionId: REPO,
  headSha: `sha${n}`,
  humanObjection: false,
  id: `eval-${n}`,
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
      evaluationsTruncated: false,
      needsHuman: 3,
      open: 4,
      truncated: false,
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
    const facts = (paths: string[], previousPaths: string[] = []) => ({
      paths,
      previousPaths,
      truncated: false,
    });
    const stored: Record<string, unknown> = {
      'eval-1': facts(['src/other.ts', 'src/pay/charge.ts']),
      'eval-2': facts(['src/other.ts']),
    };
    b.prisma.prEvaluation.findMany.mockImplementation(
      async (args: { select: Record<string, unknown>; where: { id?: { in: string[] } } }) =>
        'routingPaths' in args.select
          ? (args.where.id?.in ?? []).map((id) => ({ id, routingPaths: stored[id] }))
          : [evaluation(1), evaluation(2)]
    );
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

describe('the attention queue fails safe', () => {
  type Built = Awaited<ReturnType<typeof buildApp>>;
  const facts = (paths: string[], previousPaths: string[] = []) => ({
    paths,
    previousPaths,
    truncated: false,
  });
  /** Evaluations newest first, as the route reads them, and the stored path lists by id. */
  function serve(b: Built, evaluations: unknown[], stored: Record<string, unknown> = {}) {
    b.prisma.prEvaluation.findMany.mockImplementation(
      async (args: { select: Record<string, unknown>; where: { id?: { in: string[] } } }) =>
        'routingPaths' in args.select
          ? (args.where.id?.in ?? []).map((id) => ({ id, routingPaths: stored[id] ?? null }))
          : evaluations
    );
  }
  async function reviewOf(b: Built, pulls: unknown[], id = 'pr-1') {
    b.prisma.pullRequest.findMany.mockResolvedValue(pulls);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests?order=attention' });
    expect(res.statusCode).toBe(200);
    const row = res.json().data.find((r: { id: string }) => r.id === id);
    return { body: res.json(), review: row.review };
  }

  beforeEach(() => {
    settings.values = { ...ROUTING, 'prEvaluation.humanMinRisk': 'HIGH' };
  });

  it('treats a pull request whose newest evaluation is for another head as not evaluated', async () => {
    const b = await buildApp();
    // The row still holds the head a human pushed over; the newest evaluation is for it, and the
    // approvals and the LOW class belong to the head before.
    serve(b, [
      evaluation(1, {
        headSha: 'old',
        requiredApprovers: 1,
        riskClass: 'HIGH',
        trustedApprovers: 1,
      }),
      evaluation(1, { headSha: 'sha1', id: 'eval-older', riskClass: 'LOW' }),
    ]);
    const { review } = await reviewOf(b, [pull(1)]);
    expect(review).toMatchObject({ needsHuman: true, reason: 'not_evaluated', riskClass: null });
  });

  it('uses the newest evaluation of the head and the approvals counted there', async () => {
    const b = await buildApp();
    serve(b, [
      evaluation(1, { id: 'newest', riskClass: 'HIGH', trustedApprovers: 0 }),
      evaluation(1, { id: 'older', riskClass: 'HIGH', trustedApprovers: 2 }),
    ]);
    const { review } = await reviewOf(b, [pull(1)]);
    expect(review).toMatchObject({ needsHuman: true, reason: 'risk' });
  });

  it('keeps an always-human path ahead of standing approvals, and matches a rename source', async () => {
    const b = await buildApp();
    const overridden = { ...repository, reviewRouting: { humanPaths: ['infra/**'] } };
    serve(
      b,
      [
        evaluation(1, { requiredApprovers: 2, riskClass: 'HIGH', trustedApprovers: 2 }),
        evaluation(2, { requiredApprovers: 1, trustedApprovers: 1 }),
        evaluation(3, { requiredApprovers: 1, trustedApprovers: 1 }),
      ],
      {
        // The protected file is the 300th path, far past the brief's first fifty.
        'eval-1': facts([...Array.from({ length: 299 }, (_, i) => `src/f${i}.ts`), 'infra/a.tf']),
        'eval-2': facts(['src/moved.tf'], ['infra/old.tf']),
        'eval-3': facts(['src/ok.ts']),
      }
    );
    const pulls = [1, 2, 3].map((n) => pull(n, { repository: overridden }));
    b.prisma.pullRequest.findMany.mockResolvedValue(pulls);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests?order=attention' });
    const byId = Object.fromEntries(
      res.json().data.map((r: { id: string; review: unknown }) => [r.id, r.review])
    );
    expect(byId['pr-1']).toMatchObject({
      matchedPath: 'infra/a.tf',
      needsHuman: true,
      reason: 'path',
    });
    expect(byId['pr-2']).toMatchObject({ matchedPath: 'infra/old.tf', needsHuman: true });
    expect(byId['pr-3']).toMatchObject({ needsHuman: false, reason: 'approvals_met' });
  });

  it('asks when an always-human path is set and the row recorded no path list', async () => {
    const b = await buildApp();
    const overridden = { ...repository, reviewRouting: { humanPaths: ['infra/**'] } };
    serve(b, [evaluation(1, { requiredApprovers: 1, trustedApprovers: 1 })]);
    const { review } = await reviewOf(b, [pull(1, { repository: overridden })]);
    expect(review).toMatchObject({ matchedPath: null, needsHuman: true, reason: 'path' });
  });

  it('does not clear approvals that stand beside a request for changes, old rows included', async () => {
    const b = await buildApp();
    serve(b, [
      evaluation(1, { humanObjection: true, trustedApprovers: 1 }),
      evaluation(2, { changesRequestedCount: 1, humanObjection: null, trustedApprovers: 1 }),
      evaluation(3, { humanObjection: null, trustedApprovers: 1 }),
    ]);
    b.prisma.pullRequest.findMany.mockResolvedValue([pull(1), pull(2), pull(3)]);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests?order=attention' });
    const byId = Object.fromEntries(
      res
        .json()
        .data.map((r: { id: string; review: { reason: string } }) => [r.id, r.review.reason])
    );
    expect(byId).toEqual({
      'pr-1': 'changes_requested',
      'pr-2': 'changes_requested',
      'pr-3': 'approvals_met',
    });
  });

  it('keeps a bot-approved, armed pull request in the queue when the skip is off', async () => {
    const b = await buildApp();
    serve(b, [evaluation(1, { autoMergeEnabled: true, botApproved: true })]);
    settings.values = { ...ROUTING, 'prEvaluation.humanMinRisk': 'STANDARD' };
    const skipped = await reviewOf(b, [pull(1)]);
    expect(skipped.review).toMatchObject({ needsHuman: false, reason: 'bot_approved' });
    const off = { ...repository, reviewRouting: { skipWhenBotApproved: false } };
    const kept = await reviewOf(b, [pull(1, { repository: off })]);
    expect(kept.review).toMatchObject({ needsHuman: true, reason: 'bot_approved_review' });
  });

  it('does not clear approvals when a change request was counted after the row was written', async () => {
    const b = await buildApp();
    // The worker wrote humanObjection=false at creation; a later CHANGES_REQUESTED only bumped
    // the count on the same row.
    serve(b, [
      evaluation(1, { changesRequestedCount: 1, humanObjection: false, trustedApprovers: 1 }),
    ]);
    const { review } = await reviewOf(b, [pull(1)]);
    expect(review).toMatchObject({ needsHuman: true, reason: 'changes_requested' });
  });

  it('does not let approvals at an older head decide after a person pushed', async () => {
    const b = await buildApp();
    // The host reported head B through a synchronize webhook; the newest evaluation is for A and
    // has its approvals. No evaluation of B has landed (evaluation failed, or is off).
    serve(b, [evaluation(1, { headSha: 'aaaa', trustedApprovers: 1 })]);
    const pushed = await reviewOf(b, [pull(1, { headSha: 'aaaa', hostHeadSha: 'bbbb' })]);
    expect(pushed.review).toMatchObject({ needsHuman: true, reason: 'not_evaluated' });
    // Once B's evaluation lands as the newest row, it decides, without the worker's help.
    serve(b, [
      evaluation(1, { headSha: 'bbbb', id: 'eval-b', trustedApprovers: 1 }),
      evaluation(1, { headSha: 'aaaa', id: 'eval-a', trustedApprovers: 0 }),
    ]);
    const landed = await reviewOf(b, [pull(1, { headSha: 'aaaa', hostHeadSha: 'bbbb' })]);
    expect(landed.review).toMatchObject({ needsHuman: false, reason: 'approvals_met' });
    // With no host-reported head yet, the platform's own head is the one an evaluation must match.
    serve(b, [evaluation(1, { headSha: 'aaaa', trustedApprovers: 1 })]);
    const own = await reviewOf(b, [pull(1, { headSha: 'aaaa', hostHeadSha: null })]);
    expect(own.review).toMatchObject({ needsHuman: false, reason: 'approvals_met' });
  });

  it('treats a stored evaluation as unknown while evaluation is off for the repository', async () => {
    const b = await buildApp();
    serve(b, [evaluation(1, { trustedApprovers: 1 })]);
    const rows = [pull(1)];
    for (const off of [{ 'prEvaluation.enabled': false }, { 'prEvaluation.defaultMode': 'off' }]) {
      settings.values = { ...ROUTING, ...off };
      const { review } = await reviewOf(b, rows);
      expect(review).toMatchObject({ needsHuman: true, reason: 'not_evaluated' });
    }
    // The repository's own mode wins over the default, and a deactivated repository is off too.
    settings.values = { ...ROUTING };
    const modeOff = { ...repository, prEvaluationMode: 'off' };
    expect((await reviewOf(b, [pull(1, { repository: modeOff })])).review.reason).toBe(
      'not_evaluated'
    );
    const inactive = { ...repository, isActive: false };
    expect((await reviewOf(b, [pull(1, { repository: inactive })])).review.reason).toBe(
      'not_evaluated'
    );
    const modeOn = { ...repository, prEvaluationMode: 'enforce' };
    settings.values = { ...ROUTING, 'prEvaluation.defaultMode': 'off' };
    expect((await reviewOf(b, [pull(1, { repository: modeOn })])).review.reason).toBe(
      'approvals_met'
    );
  });

  it('reads an unrecognised risk class as HIGH', async () => {
    const b = await buildApp();
    for (const riskClass of ['high', 'CRITICAL', '']) {
      serve(b, [evaluation(1, { riskClass })]);
      const { review } = await reviewOf(b, [pull(1)]);
      expect(review).toMatchObject({ needsHuman: true, reason: 'risk', riskClass: 'HIGH' });
    }
  });

  it('gives each repository its own path-match budget', async () => {
    const b = await buildApp();
    const costly = [
      `*?*?*?*?*?*?*?*?${'?'.repeat(180)}q`,
      ...['r', 's', 't'].map((c) => `${'?'.repeat(199)}${c}`),
    ];
    const heavy = { ...repository, id: 'heavy', reviewRouting: { humanPaths: costly } };
    const light = { ...repository, id: 'light', reviewRouting: { humanPaths: ['infra/**'] } };
    const longPaths = Array.from({ length: 5000 }, (_, i) => `${'a'.repeat(250)}/${i}`);
    const rows = [
      ...Array.from({ length: 40 }, (_, i) =>
        pull(i + 1, {
          id: `h${i}`,
          openedAt: new Date(1_700_000_000_000 + i),
          prNumber: i + 1,
          repoId: 'heavy',
          repository: heavy,
        })
      ),
      pull(1, { id: 'l1', prNumber: 1, repoId: 'light', repository: light }),
    ];
    b.prisma.pullRequest.findMany.mockResolvedValue(rows);
    b.prisma.prEvaluation.findMany.mockImplementation(
      async (args: { select: Record<string, unknown>; where: { id?: { in: string[] } } }) =>
        'routingPaths' in args.select
          ? (args.where.id?.in ?? []).map((id) => ({
              id,
              routingPaths: {
                paths: id.startsWith('l') ? ['src/ok.ts'] : longPaths,
                previousPaths: [],
                truncated: false,
              },
            }))
          : [
              ...Array.from({ length: 40 }, (_, i) =>
                evaluation(i + 1, {
                  connectionId: 'heavy',
                  headSha: `sha${i + 1}`,
                  id: `h${i}`,
                  requiredApprovers: 1,
                  trustedApprovers: 1,
                })
              ),
              evaluation(1, {
                connectionId: 'light',
                headSha: 'sha1',
                id: 'l1',
                requiredApprovers: 1,
                trustedApprovers: 1,
              }),
            ]
    );
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests?order=attention' });
    const byId = Object.fromEntries(
      res
        .json()
        .data.map((r: { id: string; review: { reason: string } }) => [r.id, r.review.reason])
    );
    // The heavy repository runs out of its own budget and reads as unchecked ...
    expect(byId.h39).toBe('path');
    // ... and the light one is still checked, and clears on its approvals.
    expect(byId.l1).toBe('approvals_met');
  });

  it('reads only small columns for the evaluations, and exact pairs', async () => {
    const b = await buildApp();
    serve(b, [evaluation(1)]);
    await reviewOf(b, [pull(1), pull(2)]);
    const call = b.prisma.prEvaluation.findMany.mock.calls[0]?.[0];
    expect(Object.keys(call.select)).not.toContain('brief');
    expect(Object.keys(call.select)).not.toContain('routingPaths');
    expect(call.where).toEqual({ OR: [{ connectionId: REPO, prNumber: { in: [1, 2] } }] });
    // No always-human path is set, so no path list is read at all.
    expect(b.prisma.prEvaluation.findMany).toHaveBeenCalledTimes(1);
  });

  it('says so when the evaluation read is cut, and counts the pull requests when the queue is', async () => {
    const b = await buildApp();
    const many = Array.from({ length: 1001 }, (_, i) =>
      pull(i + 1, { id: `pr-${i + 1}`, openedAt: new Date(1_700_000_000_000 + i) })
    );
    serve(
      b,
      Array.from({ length: 20_001 }, (_, i) => evaluation(i + 1, { id: `e${i}` }))
    );
    b.prisma.pullRequest.count.mockResolvedValue(1500);
    const { body } = await reviewOf(b, many);
    expect(body.meta.queue).toMatchObject({
      evaluationsTruncated: true,
      open: 1000,
      truncated: true,
    });
    expect(body.meta.total).toBe(1500);
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
    expect(data.queue).toMatchObject({ needsHuman: 1, open: 1, truncated: false });
    expect(data.truncated).toBe(false);
    // The cohort's evaluations are asked for as exact (repository, number) pairs.
    const cohortRead = b.prisma.prEvaluation.findMany.mock.calls.find(
      (call) => 'firstHumanReviewAt' in call[0].select
    )?.[0];
    expect(cohortRead.where.OR).toEqual([{ connectionId: REPO, prNumber: { in: [1, 2] } }]);
    // Drafts have not asked for review, so they are outside the cohort.
    const cohortWhere = b.prisma.pullRequest.findMany.mock.calls.find(
      (call) => 'reviewVisits' in call[0].select
    )?.[0].where.AND;
    expect(cohortWhere).toContainEqual({ isDraft: false });
  });
});
