import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveGitHubBaseUrl: vi.fn(async () => 'https://github.com'),
}));

vi.mock('@auto-swe/shared/config', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/config')>()),
  resolveSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, k.endsWith('humanMinRisk') ? 'LOW' : 0]))
  ),
}));

import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestRoutes } from './pullRequests.js';

const TEAM = '00000000-0000-4000-8000-00000000000b';
const AUTH = { authorization: 'Bearer fake' };

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The gateway's own handler shape: statusCode and code on the error become the envelope.
  app.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, _r, reply) =>
    reply
      .status(error.statusCode ?? 500)
      .send({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } })
  );
  const prisma = {
    prEvaluation: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    team: { findFirst: vi.fn().mockResolvedValue({ id: TEAM }) },
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

describe('GET /api/v1/pull-requests teamId', () => {
  it('scopes the list to repositories the team owns or that are shared to it', async () => {
    const b = await buildApp();
    const res = await b.app.inject({
      headers: AUTH,
      url: `/api/v1/pull-requests?scope=TEAM&teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    expect(b.prisma.pullRequest.findMany.mock.calls[0]?.[0].where.AND).toEqual([
      { repository: reachableConnections({ sub: 'user-1' }, { mode: 'off', staleAfterHours: 0 }) },
      { repository: { OR: [{ teamId: TEAM }, { shares: { some: { teamId: TEAM } } }] } },
    ]);
  });

  it('answers 404 TEAM_NOT_FOUND for a non-member and reads nothing', async () => {
    const b = await buildApp();
    b.prisma.team.findFirst.mockResolvedValue(null);
    const res = await b.app.inject({
      headers: AUTH,
      url: `/api/v1/pull-requests?scope=TEAM&teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEAM_NOT_FOUND');
    expect(b.prisma.pullRequest.findMany).not.toHaveBeenCalled();
  });

  it('lets a platform ADMIN through without a membership lookup', async () => {
    const b = await buildApp('ADMIN');
    b.prisma.team.findFirst.mockResolvedValue(null);
    const res = await b.app.inject({
      headers: AUTH,
      url: `/api/v1/pull-requests?scope=TEAM&teamId=${TEAM}`,
    });
    expect(res.statusCode).toBe(200);
    expect(b.prisma.team.findFirst).not.toHaveBeenCalled();
  });

  it('names the team that owns each row’s repository, for a team chip', async () => {
    const b = await buildApp();
    const row = (id: string, team: { id: string; name: string; slug: string } | null) => ({
      ciStatus: 'PASSED',
      closedAt: null,
      id,
      isDraft: false,
      mergedAt: null,
      openedAt: new Date('2026-06-01T00:00:00Z'),
      prNumber: 7,
      repoId: 'repo-1',
      repository: {
        githubUrl: null,
        id: 'repo-1',
        organizationName: 'acme',
        repoName: 'api',
        team,
      },
      status: 'OPEN',
      title: 'Add endpoint',
      workflow: null,
    });
    b.prisma.pullRequest.findMany.mockResolvedValue([
      row('pr-1', { id: TEAM, name: 'Payments', slug: 'payments' }),
      row('pr-2', null),
    ]);
    const res = await b.app.inject({ headers: AUTH, url: '/api/v1/pull-requests' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: { ownerTeam: unknown }) => r.ownerTeam)).toEqual([
      { id: TEAM, name: 'Payments', slug: 'payments' },
      null,
    ]);
    const include = b.prisma.pullRequest.findMany.mock.calls[0]?.[0].include;
    expect(include.repository.select.team).toEqual({
      select: { id: true, name: true, slug: true },
    });
  });
});
