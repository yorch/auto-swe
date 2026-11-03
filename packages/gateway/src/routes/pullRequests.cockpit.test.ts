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

const m = vi.hoisted(() => ({ readPullFiles: vi.fn() }));
vi.mock('../lib/githubPullFiles.js', () => ({ readPullFiles: m.readPullFiles }));

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
    prEvaluation: { findFirst: vi.fn().mockResolvedValue(evaluationRow) },
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
  m.readPullFiles.mockReset();
  m.readPullFiles.mockResolvedValue(okFiles);
});

describe('GET /api/v1/pull-requests/:id/cockpit', () => {
  it('answers the pull request, its latest evaluation and the live files', async () => {
    const b = await buildApp();
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
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
