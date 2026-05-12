import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDefaultTemplate, workRequestRoutes } from './workRequests.js';

describe('POST /api/v1/work-requests', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Mock auth plugin — verifyAccessToken accepts any non-empty token in tests
    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) throw new Error('No token');
        return { exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' };
      },
    } as unknown as never);

    // Mock prisma and temporal on the app instance (cast through unknown to bypass strict typing)
    app.decorate('prisma', {
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => ({
          id: 'wf-1',
          ...args.data,
        }),
      },
      repository: {
        findUnique: async () => ({
          id: 'repo-1',
          isActive: true,
          organizationName: 'org',
          repoName: 'test',
          team: { memberships: [{ userId: 'user-1' }] },
          teamId: 'team-1',
        }),
      },
      workflowTemplate: {
        findFirst: async () => ({
          activeVersion: 1,
          id: 'tpl-1',
        }),
      },
      workRequest: {
        create: async (args: { data: Record<string, unknown> }) => ({ id: 'wr-1', ...args.data }),
      },
    } as unknown as never);
    app.decorate('temporal', {
      signalWorkflow: async () => {},
      startEpicWorkflow: async () => {},
      startRunnableWorkflow: async () => {},
    });

    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterAll(() => app.close());

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing description', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { externalTicketId: 'JIRA-1', repoIds: ['00000000-0000-4000-8000-000000000001'] },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a work request', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.workRequestId).toBeDefined();
  });
});

describe('resolveDefaultTemplate', () => {
  function fakePrisma(opts: {
    teamMatch?: { id: string; activeVersion: number | null } | null;
    globalMatch?: { id: string; activeVersion: number | null } | null;
  }) {
    const findFirst = vi
      .fn()
      .mockImplementationOnce(async () => opts.teamMatch ?? null)
      .mockImplementationOnce(async () => opts.globalMatch ?? null);
    return { findFirst, prisma: { workflowTemplate: { findFirst } } };
  }

  it('prefers the team default over the global default', async () => {
    const { prisma } = fakePrisma({
      globalMatch: { activeVersion: 2, id: 'global-tpl' },
      teamMatch: { activeVersion: 5, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ templateId: 'team-tpl', version: 5 });
  });

  it('falls back to the global default when no team default exists', async () => {
    const { findFirst, prisma } = fakePrisma({
      globalMatch: { activeVersion: 1, id: 'global-tpl' },
      teamMatch: null,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ templateId: 'global-tpl', version: 1 });
    expect(findFirst).toHaveBeenCalledTimes(2);
    const secondWhere = findFirst.mock.calls[1]?.[0]?.where as Record<string, unknown>;
    expect(secondWhere.teamId).toBeNull();
  });

  it('returns null when neither a team nor global default is configured', async () => {
    const { prisma } = fakePrisma({ globalMatch: null, teamMatch: null });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });

  it('returns null when the matched template has no activeVersion', async () => {
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: { activeVersion: null, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });
});
