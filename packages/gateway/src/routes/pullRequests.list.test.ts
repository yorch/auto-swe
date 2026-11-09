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
});
