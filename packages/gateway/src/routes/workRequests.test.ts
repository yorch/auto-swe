import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workRequestRoutes } from './workRequests.js';

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
    } as any);

    // Mock prisma and temporal on the app instance (cast as any to bypass strict typing)
    app.decorate('prisma', {
      activeWorkflow: { create: async (args: any) => ({ id: 'wf-1', ...args.data }) },
      repository: {
        findUnique: async () => ({
          id: 'repo-1',
          isActive: true,
          organizationName: 'org',
          repoName: 'test',
          team: { memberships: [{ userId: 'user-1' }] },
        }),
      },
      workRequest: { create: async (args: any) => ({ id: 'wr-1', ...args.data }) },
    } as any);
    app.decorate('temporal', {
      signalWorkflow: async () => {},
      startEpicWorkflow: async () => {},
      startWorkflow: async () => {},
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
