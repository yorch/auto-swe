import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GATE = { mode: 'off', staleAfterHours: 0 } as const;
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveGitHubBaseUrl: async () => 'https://github.com',
}));

const m = vi.hoisted(() => ({ readCompare: vi.fn(), readPullFiles: vi.fn() }));
vi.mock('../lib/githubPullFiles.js', async (orig) => ({
  ...(await orig<typeof import('../lib/githubPullFiles.js')>()),
  readCompare: m.readCompare,
  readPullFiles: m.readPullFiles,
}));

import { buildWorkflowRunVisibilityFilter } from '../lib/runVisibility.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestRoutes } from './pullRequests.js';

const AUTH = { authorization: 'Bearer fake' };
const PR_ID = '00000000-0000-4000-8000-0000000000aa';
const REPO_ID = '00000000-0000-4000-8000-0000000000bb';
const HEAD = 'abc123';
const PATCH = ['@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'].join('\n');

type Role = 'ADMIN' | 'ENGINEER';

const repository = {
  githubApiUrl: null,
  githubUrl: 'https://github.com',
  id: REPO_ID,
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
};

function pullRow(over: Record<string, unknown> = {}) {
  return {
    ciStatus: 'PASSED',
    closedAt: null,
    headSha: HEAD,
    id: PR_ID,
    isDraft: false,
    mergedAt: null,
    openedAt: new Date('2026-11-01T09:00:00.000Z'),
    prNumber: 7,
    repoId: REPO_ID,
    repository,
    status: 'OPEN',
    title: 'Add the thing',
    workflow: {
      costUsdAccrued: 1.5,
      repoId: REPO_ID,
      temporalWorkflowId: 'wf-1',
      workRequest: { externalTicketId: 'JIRA-1', id: 'wr-1' },
    },
    ...over,
  };
}

const evaluationRow = {
  brief: {
    claimsToVerify: [],
    findings: [
      {
        category: 'logic',
        description: 'off by one',
        file: 'src/a.ts',
        line: 2,
        reviewer: 'DOMAIN_LOGIC',
        severity: 'WARNING',
        suggestedFix: 'use <=',
      },
    ],
    path: [{ flagged: true, path: 'src/a.ts', verify: 'v', why: 'w' }],
    skim: [],
  },
  createdAt: new Date('2026-11-03T10:00:00.000Z'),
  headSha: HEAD,
  id: 'eval-1',
  mode: 'advisory',
  reasons: [],
  requiredApprovers: 1,
  riskClass: 'STANDARD',
  statusState: 'pending',
};

const okFiles = {
  files: [
    {
      additions: 1,
      deletions: 0,
      patch: PATCH,
      patchDigest: 'digest',
      path: 'src/a.ts',
      status: 'modified',
    },
  ],
  headSha: HEAD,
  state: 'open',
  truncated: false,
  type: 'ok',
};

async function buildApp(role: Role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    prEvaluation: { findFirst: vi.fn().mockResolvedValue(evaluationRow) },
    prFileView: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(async (args: { update: { patchDigest: string } }) => args),
    },
    prReviewVisit: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    pullRequest: { findFirst: vi.fn().mockResolvedValue(pullRow()) },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED' }) },
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

const get = (b: Built, id = PR_ID) =>
  b.app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/pull-requests/${id}/cockpit` });

beforeEach(() => {
  m.readCompare.mockReset();
  m.readPullFiles.mockReset();
  m.readPullFiles.mockResolvedValue(okFiles);
});

describe('GET /api/v1/pull-requests/:id/cockpit', () => {
  it('answers the pull request, its latest evaluation and the live files', async () => {
    const b = await buildApp();
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    // `pull` leads: the in-app assistant keeps only the start of a long answer.
    expect(Object.keys(data)).toEqual([
      'pull',
      'evaluation',
      'files',
      'changedSinceViewed',
      'sinceLastVisit',
      'viewed',
    ]);
    expect(data.pull).toMatchObject({
      headSha: HEAD,
      id: PR_ID,
      latestRun: { id: 'run-1', status: 'COMPLETED' },
      prNumber: 7,
      repository: { id: REPO_ID, name: 'api', org: 'acme' },
      ticketId: 'JIRA-1',
      title: 'Add the thing',
      url: 'https://github.com/acme/api/pull/7',
      workRequestId: 'wr-1',
    });
    expect(data.evaluation).toMatchObject({ id: 'eval-1', riskClass: 'STANDARD', stale: false });
    expect(data.evaluation.findings).toEqual([
      expect.objectContaining({ anchored: true, description: 'off by one' }),
    ]);
    expect(data.files).toMatchObject({ headSha: HEAD, type: 'ok' });
    expect(data.files.items[0]).toMatchObject({ flagged: true, path: 'src/a.ts' });
    expect(m.readPullFiles).toHaveBeenCalledWith(repository, 7);
  });

  describe('who may see it', () => {
    it('limits an engineer to the repositories they can reach', async () => {
      const b = await buildApp('ENGINEER');
      await get(b);
      const where = b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where;
      expect(where).toEqual({
        id: PR_ID,
        repository: reachableConnections({ sub: 'user-1' }, GATE),
      });
    });

    it('applies no reach filter for an admin', async () => {
      const b = await buildApp('ADMIN');
      await get(b);
      expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ id: PR_ID });
    });

    it('answers 404 for a pull request the caller cannot reach, and never asks the host', async () => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue(null);
      const res = await get(b);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PULL_REQUEST_NOT_FOUND');
      expect(m.readPullFiles).not.toHaveBeenCalled();
      expect(b.prisma.prEvaluation.findFirst).not.toHaveBeenCalled();
    });

    it('rejects an id that is not a uuid before reading anything', async () => {
      const b = await buildApp();
      const res = await get(b, 'not-a-uuid');
      expect(res.statusCode).toBe(400);
      expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
    });

    it('reads the evaluation through the same reach filter, for the same repository and number', async () => {
      const b = await buildApp('ENGINEER');
      await get(b);
      const call = b.prisma.prEvaluation.findFirst.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        connection: reachableConnections({ sub: 'user-1' }, GATE),
        connectionId: REPO_ID,
        prNumber: 7,
      });
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('shows the run only while the caller may see it', async () => {
      const b = await buildApp('ENGINEER');
      await get(b);
      expect(b.prisma.workflowRun.findFirst.mock.calls[0]?.[0].where).toEqual({
        AND: [
          buildWorkflowRunVisibilityFilter({ sub: 'user-1' } as never, GATE),
          { workflowId: 'wf-1' },
        ],
      });
      b.prisma.workflowRun.findFirst.mockResolvedValue(null);
      expect((await get(b)).json().data.pull.latestRun).toBeNull();
    });

    it('ignores a ledger row on another repository: no ticket, cost or run', async () => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue(
        pullRow({
          workflow: {
            costUsdAccrued: 9,
            repoId: 'some-other-repo',
            temporalWorkflowId: 'wf-2',
            workRequest: { externalTicketId: 'JIRA-9', id: 'wr-9' },
          },
        })
      );
      const { data } = (await get(b)).json();
      expect(data.pull).toMatchObject({
        costUsd: null,
        latestRun: null,
        ticketId: null,
        workRequestId: null,
      });
      expect(b.prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('when something cannot be read', () => {
    it('still answers, with the files unavailable and the reason, when the host cannot be read', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue({ reason: 'rate-limited', type: 'unavailable' });
      const res = await get(b);
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.files).toEqual({ reason: 'rate-limited', type: 'unavailable' });
      expect(data.evaluation.id).toBe('eval-1');
    });

    it('has no evaluation to show for a pull request that was never evaluated', async () => {
      const b = await buildApp();
      b.prisma.prEvaluation.findFirst.mockResolvedValue(null);
      expect((await get(b)).json().data.evaluation).toBeNull();
    });

    it('asks nothing of the host or the evaluations for a row with no pull request number', async () => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue(pullRow({ prNumber: null }));
      const { data } = (await get(b)).json();
      expect(data.files).toEqual({ reason: 'not-found', type: 'unavailable' });
      expect(data.evaluation).toBeNull();
      expect(m.readPullFiles).not.toHaveBeenCalled();
      expect(b.prisma.prEvaluation.findFirst).not.toHaveBeenCalled();
    });

    it('asks nothing of the host for a row whose repository was removed', async () => {
      const b = await buildApp('ADMIN');
      b.prisma.pullRequest.findFirst.mockResolvedValue(pullRow({ repoId: null, repository: null }));
      const { data } = (await get(b)).json();
      expect(data.pull.repository).toBeNull();
      expect(data.pull.url).toBeNull();
      expect(data.files).toEqual({ reason: 'not-found', type: 'unavailable' });
      expect(m.readPullFiles).not.toHaveBeenCalled();
    });
  });
});

describe('the viewed marks in the cockpit', () => {
  it('lists the files the caller viewed whose patch has not changed since', async () => {
    const b = await buildApp();
    b.prisma.prFileView.findMany.mockResolvedValue([
      { patchDigest: 'digest', path: 'src/a.ts' },
      { patchDigest: 'older-digest', path: 'src/b.ts' },
    ]);
    const { data } = (await get(b)).json();
    expect(data.viewed).toEqual(['src/a.ts']);
  });

  it("reads only the caller's own marks, for this pull request, and bounded", async () => {
    const b = await buildApp();
    await get(b);
    expect(b.prisma.prFileView.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 3000,
      where: { pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  it('lists none while the files cannot be read', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue({ reason: 'failed', type: 'unavailable' });
    b.prisma.prFileView.findMany.mockResolvedValue([{ patchDigest: 'digest', path: 'src/a.ts' }]);
    expect((await get(b)).json().data.viewed).toEqual([]);
  });
});

describe('what changed since the caller last looked', () => {
  const OLD_HEAD = 'a'.repeat(40);
  const NEW_HEAD = 'b'.repeat(40);
  const visited = { lastHeadSha: OLD_HEAD, lastVisitedAt: new Date('2026-11-02T08:00:00.000Z') };
  const moved = { ...okFiles, headSha: NEW_HEAD };

  it('names the files marked viewed whose patch has changed since the mark', async () => {
    const b = await buildApp();
    b.prisma.prFileView.findMany.mockResolvedValue([
      { patchDigest: 'older-digest', path: 'src/a.ts' },
      { patchDigest: 'x', path: 'src/gone.ts' },
    ]);
    const { data } = (await get(b)).json();
    expect(data.viewed).toEqual([]);
    expect(data.changedSinceViewed).toEqual(['src/a.ts']);
  });

  it('has no earlier visit to report on a first look', async () => {
    const b = await buildApp();
    const { data } = (await get(b)).json();
    expect(data.sinceLastVisit).toBeNull();
    expect(m.readCompare).not.toHaveBeenCalled();
  });

  it("reads only the caller's own visit, for this pull request", async () => {
    const b = await buildApp();
    await get(b);
    expect(b.prisma.prReviewVisit.findUnique.mock.calls[0]?.[0].where).toEqual({
      userId_pullRequestId: { pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  it('says nothing when the head is the one the caller saw, in any case', async () => {
    const b = await buildApp();
    b.prisma.prReviewVisit.findUnique.mockResolvedValue({ ...visited, lastHeadSha: 'ABC123' });
    expect((await get(b)).json().data.sinceLastVisit).toBeNull();
    expect(m.readCompare).not.toHaveBeenCalled();
  });

  it('lists the commits between the head they saw and the head now', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue(moved);
    b.prisma.prReviewVisit.findUnique.mockResolvedValue(visited);
    m.readCompare.mockResolvedValue({
      commits: [{ sha: 'c1', subject: 'fix it' }],
      rewritten: false,
      totalCommits: 1,
      type: 'ok',
    });
    const { data } = (await get(b)).json();
    expect(data.sinceLastVisit).toEqual({
      commits: [{ sha: 'c1', subject: 'fix it' }],
      fromHeadSha: OLD_HEAD,
      lastVisitedAt: '2026-11-02T08:00:00.000Z',
      rewritten: false,
      totalCommits: 1,
    });
    expect(m.readCompare).toHaveBeenCalledWith(repository, OLD_HEAD, NEW_HEAD);
  });

  it('passes a rewritten branch on', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue(moved);
    b.prisma.prReviewVisit.findUnique.mockResolvedValue(visited);
    m.readCompare.mockResolvedValue({ commits: [], rewritten: true, totalCommits: 0, type: 'ok' });
    expect((await get(b)).json().data.sinceLastVisit).toMatchObject({ rewritten: true });
  });

  it('still says the head moved, without commits, when the host cannot be asked', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue(moved);
    b.prisma.prReviewVisit.findUnique.mockResolvedValue(visited);
    m.readCompare.mockResolvedValue({ reason: 'rate-limited', type: 'unavailable' });
    expect((await get(b)).json().data.sinceLastVisit).toMatchObject({
      commits: null,
      fromHeadSha: OLD_HEAD,
      rewritten: false,
    });
  });

  it('reports nothing while the host cannot say what the head is now', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue({ reason: 'failed', type: 'unavailable' });
    b.prisma.prReviewVisit.findUnique.mockResolvedValue(visited);
    expect((await get(b)).json().data.sinceLastVisit).toBeNull();
    expect(m.readCompare).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/pull-requests/:id/visit', () => {
  const SHA = 'c'.repeat(40);
  const post = (b: Built, body: unknown, id = PR_ID) =>
    b.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: body as never,
      url: `/api/v1/pull-requests/${id}/visit`,
    });

  it('records the head for the caller, keeping the first visit time', async () => {
    const b = await buildApp();
    const res = await post(b, { headSha: SHA });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ recorded: true });
    expect(b.prisma.prReviewVisit.upsert).toHaveBeenCalledWith({
      create: {
        firstVisitedAt: expect.any(Date),
        lastHeadSha: SHA,
        lastVisitedAt: expect.any(Date),
        pullRequestId: PR_ID,
        userId: 'user-1',
      },
      update: { lastHeadSha: SHA, lastVisitedAt: expect.any(Date) },
      where: { userId_pullRequestId: { pullRequestId: PR_ID, userId: 'user-1' } },
    });
  });

  it('limits an engineer to repositories they can reach, and answers 404 otherwise', async () => {
    const b = await buildApp('ENGINEER');
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    expect((await post(b, { headSha: SHA })).statusCode).toBe(404);
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: PR_ID,
      repository: reachableConnections({ sub: 'user-1' }, GATE),
    });
    expect(b.prisma.prReviewVisit.upsert).not.toHaveBeenCalled();
  });

  it('applies no reach filter for an admin', async () => {
    const b = await buildApp('ADMIN');
    await post(b, { headSha: SHA });
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ id: PR_ID });
  });

  it.each([
    ['no head', {}],
    ['a branch name', { headSha: 'main' }],
    ['a path', { headSha: `${SHA}/../x` }],
    ['a short id', { headSha: 'c'.repeat(39) }],
  ])('rejects %s before reading anything', async (_name, body) => {
    const b = await buildApp();
    expect((await post(b, body)).statusCode).toBe(400);
    expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
    expect(b.prisma.prReviewVisit.upsert).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a uuid', async () => {
    const b = await buildApp();
    expect((await post(b, { headSha: SHA }, 'nope')).statusCode).toBe(400);
  });
});

describe('PUT /api/v1/pull-requests/:id/viewed', () => {
  const DIGEST = 'a'.repeat(64);
  const put = (b: Built, body: unknown, id = PR_ID) =>
    b.app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: body as never,
      url: `/api/v1/pull-requests/${id}/viewed`,
    });
  const mark = (path = 'src/a.ts', patchDigest = DIGEST) => ({ patchDigest, path });

  it('records a mark for the caller, keyed to this pull request and path', async () => {
    const b = await buildApp();
    const res = await put(b, { files: [mark()], viewed: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ updated: 1 });
    expect(b.prisma.prFileView.upsert).toHaveBeenCalledWith({
      create: { patchDigest: DIGEST, path: 'src/a.ts', pullRequestId: PR_ID, userId: 'user-1' },
      update: { patchDigest: DIGEST, viewedAt: expect.any(Date) },
      where: {
        userId_pullRequestId_path: { path: 'src/a.ts', pullRequestId: PR_ID, userId: 'user-1' },
      },
    });
  });

  it('keeps the last digest when a request names a path twice', async () => {
    const b = await buildApp();
    const second = 'b'.repeat(64);
    await put(b, { files: [mark('src/a.ts'), mark('src/a.ts', second)], viewed: true });
    expect(b.prisma.prFileView.upsert).toHaveBeenCalledTimes(1);
    expect(b.prisma.prFileView.upsert.mock.calls[0]?.[0].update.patchDigest).toBe(second);
  });

  it("clears the marks, only the caller's and only the ones named", async () => {
    const b = await buildApp();
    b.prisma.prFileView.deleteMany.mockResolvedValue({ count: 2 });
    const res = await put(b, { files: [mark('src/a.ts'), mark('src/b.ts')], viewed: false });
    expect(res.json().data).toEqual({ updated: 2 });
    expect(b.prisma.prFileView.deleteMany).toHaveBeenCalledWith({
      where: { path: { in: ['src/a.ts', 'src/b.ts'] }, pullRequestId: PR_ID, userId: 'user-1' },
    });
    expect(b.prisma.prFileView.upsert).not.toHaveBeenCalled();
  });

  it('limits an engineer to repositories they can reach, and answers 404 otherwise', async () => {
    const b = await buildApp('ENGINEER');
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    const res = await put(b, { files: [mark()], viewed: true });
    expect(res.statusCode).toBe(404);
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: PR_ID,
      repository: reachableConnections({ sub: 'user-1' }, GATE),
    });
    expect(b.prisma.prFileView.upsert).not.toHaveBeenCalled();
    expect(b.prisma.prFileView.deleteMany).not.toHaveBeenCalled();
  });

  it('applies no reach filter for an admin', async () => {
    const b = await buildApp('ADMIN');
    await put(b, { files: [mark()], viewed: true });
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ id: PR_ID });
  });

  it('refuses a mark that would pass the most one pull request can have', async () => {
    const b = await buildApp();
    b.prisma.prFileView.count.mockResolvedValue(2999);
    const res = await put(b, { files: [mark('src/a.ts'), mark('src/b.ts')], viewed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_VIEWED_FILES');
    expect(b.prisma.prFileView.upsert).not.toHaveBeenCalled();
  });

  it('does not count a path that is already marked against the limit', async () => {
    const b = await buildApp();
    b.prisma.prFileView.count.mockResolvedValue(3000);
    b.prisma.prFileView.findMany.mockResolvedValue([{ path: 'src/a.ts' }]);
    const res = await put(b, { files: [mark('src/a.ts')], viewed: true });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['no files', { files: [], viewed: true }],
    [
      'too many files',
      { files: Array.from({ length: 201 }, (_, i) => mark(`f${i}`)), viewed: true },
    ],
    ['a short digest', { files: [mark('src/a.ts', 'abc')], viewed: true }],
    ['an upper-case digest', { files: [mark('src/a.ts', 'A'.repeat(64))], viewed: true }],
    ['an empty path', { files: [mark('')], viewed: true }],
    ['a path past the key limit', { files: [mark('p'.repeat(501))], viewed: true }],
    ['no viewed flag', { files: [mark()] }],
  ])('rejects %s before reading anything', async (_name, body) => {
    const b = await buildApp();
    const res = await put(b, body);
    expect(res.statusCode).toBe(400);
    expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a uuid', async () => {
    const b = await buildApp();
    expect((await put(b, { files: [mark()], viewed: true }, 'nope')).statusCode).toBe(400);
  });
});
