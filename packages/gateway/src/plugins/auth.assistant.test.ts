import { assistantActionDigest } from '@auto-swe/shared/lib/assistantAction';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_ID,
  type AssistantPrisma,
  assistantBearer,
  buildAssistantApp,
  CONVERSATION_ID,
  makeAssistantPrisma,
  personBearer,
  USER_ID,
} from '../test/assistantApp.js';
import { _resetAuthCachesForTests, rateLimitKey, requireAuth } from './auth.js';

const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: settings.resolveSetting }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

/**
 * The assistant's path through `requireAuth`, against routes registered at the URLs the policy table
 * names, so each case exercises the table entry production would.
 */

const seen: Array<FastifyRequest['assistant']> = [];
const handler = async (request: FastifyRequest) => {
  seen.push(request.assistant ? { ...request.assistant } : undefined);
  return { ok: true, user: request.user?.sub };
};

async function routes(app: FastifyInstance) {
  // read
  app.get('/api/v1/workflow-runs/:id', { onRequest: requireAuth() }, handler);
  // confirm, authenticated before the body is parsed
  app.post('/api/v1/work-requests', { onRequest: requireAuth() }, handler);
  // confirm, authenticated only after the body is parsed (as `configSettings.ts` does for writes)
  app.put('/api/v1/platform/config/settings/:key', { preHandler: requireAuth() }, handler);
  // confirm, authenticated twice: a plugin-wide hook and the route's own
  app.patch(
    '/api/v1/repositories/:id',
    { onRequest: requireAuth(), preHandler: requireAuth({ requiredRole: 'ENGINEER' }) },
    handler
  );
  // confirm, behind a role the user lacks
  app.post(
    '/api/v1/platform/skills',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }) },
    handler
  );
  // never
  app.post('/api/v1/human-steps/:id/respond', { onRequest: requireAuth() }, handler);
  // DELETE, never whatever the table says
  app.delete('/api/v1/platform/skills/:id', { onRequest: requireAuth() }, handler);
  // not in the table at all
  app.get('/api/v1/not-in-the-table', { onRequest: requireAuth() }, handler);
}

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const WORK_REQUEST = { description: 'Add a health check', repoIds: [RUN_ID] };

describe('requireAuth — assistant tokens', () => {
  let app: FastifyInstance;
  let prisma: AssistantPrisma;

  beforeEach(async () => {
    _resetAuthCachesForTests();
    seen.length = 0;
    settings.resolveSetting.mockReset().mockResolvedValue(true);
    prisma = makeAssistantPrisma();
    app = await buildAssistantApp(prisma, routes);
  });
  afterEach(async () => {
    await app.close();
  });

  /** Make the next spend succeed for a confirmation of `request`. */
  function confirmed(request: { method: string; url: string; body?: unknown }) {
    prisma.assistantAction.updateMany.mockResolvedValue({ count: 1 });
    prisma.assistantAction.findUnique.mockResolvedValue({
      digest: assistantActionDigest({ ...request, body: request.body }),
    });
  }

  describe('reads', () => {
    it('acts as the user on a read route and marks the request as the assistant', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toBe(USER_ID);
      expect(seen).toEqual([{ access: 'read', conversationId: CONVERSATION_ID }]);
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });

    it('leaves request.assistant unset for the person themselves', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([undefined]);
    });
  });

  describe('refusals before the route runs', () => {
    it.each([
      ['a never route', 'POST', `/api/v1/human-steps/${RUN_ID}/respond`],
      ['a DELETE', 'DELETE', `/api/v1/platform/skills/${RUN_ID}`],
      ['a route missing from the table', 'GET', '/api/v1/not-in-the-table'],
    ] as const)('refuses %s with ASSISTANT_NOT_ALLOWED', async (_name, method, url) => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method,
        payload: method === 'POST' ? { decision: 'approve' } : undefined,
        url,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_NOT_ALLOWED');
      expect(seen).toEqual([]);
    });

    it('refuses a token whose conversation is closed or not its user’s', async () => {
      prisma.assistantConversation.findFirst.mockResolvedValue(null);
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_INVALID');
      expect(prisma.assistantConversation.findFirst.mock.calls[0][0].where).toEqual({
        closedAt: null,
        id: CONVERSATION_ID,
        userId: USER_ID,
      });
    });

    it('refuses every call while assistant.enabled is off', async () => {
      settings.resolveSetting.mockResolvedValue(false);
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_DISABLED');
      expect(settings.resolveSetting).toHaveBeenCalledWith('assistant.enabled');
    });

    it('fails closed when assistant.enabled cannot be read', async () => {
      settings.resolveSetting.mockRejectedValue(new Error('db down'));
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('ASSISTANT_UNAVAILABLE');
    });

    it('refuses a token whose user has been deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        isActive: false,
        role: 'ENGINEER',
        slackId: null,
      });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('TOKEN_INVALID');
    });

    it('refuses an API access token dressed in the assistant prefix', async () => {
      const apiToken = app.auth.signAccessToken({ role: 'ENGINEER', sub: USER_ID });
      const res = await app.inject({
        headers: { authorization: `Bearer asst_${apiToken}` },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses an assistant token presented as an API access token', async () => {
      const token = assistantBearer(app).slice('Bearer asst_'.length);
      const res = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        url: `/api/v1/workflow-runs/${RUN_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('still applies the route’s role check to the user', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'POST',
        payload: { name: 'x' },
        url: '/api/v1/platform/skills',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      // A refused request must not spend the user's confirmation.
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('writes need a confirmation of the exact request', () => {
    it('refuses a write with no confirmation', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_REQUIRED');
      expect(seen).toEqual([]);
    });

    it('spends a matching confirmation once and runs the route', async () => {
      confirmed({ body: WORK_REQUEST, method: 'POST', url: '/api/v1/work-requests' });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([
        { access: 'confirm', actionId: ACTION_ID, conversationId: CONVERSATION_ID },
      ]);
      expect(prisma.assistantAction.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.assistantAction.updateMany.mock.calls[0][0].where).toMatchObject({
        conversationId: CONVERSATION_ID,
        id: ACTION_ID,
        status: 'CONFIRMED',
        userId: USER_ID,
      });
      expect(prisma.assistantAction.updateMany.mock.calls[0][0].data.status).toBe('EXECUTED');
    });

    it('refuses, and still spends, a confirmation for a different body', async () => {
      confirmed({ body: WORK_REQUEST, method: 'POST', url: '/api/v1/work-requests' });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'POST',
        payload: { ...WORK_REQUEST, description: 'Delete the production database' },
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_MISMATCH');
      expect(prisma.assistantAction.updateMany).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]);
    });

    it('refuses a confirmation for a different URL', async () => {
      confirmed({ body: WORK_REQUEST, method: 'POST', url: '/api/v1/work-requests' });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests?dryRun=false',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_MISMATCH');
    });

    it('refuses when no confirmed, unexpired row of this user and conversation matches', async () => {
      prisma.assistantAction.updateMany.mockResolvedValue({ count: 0 });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_INVALID');
      expect(prisma.assistantAction.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a malformed action id without touching the database', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': 'not-a-uuid' },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_REQUIRED');
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });

    it('checks the confirmation on a route that authenticates only after parsing', async () => {
      const body = { value: 30 };
      const url = '/api/v1/platform/config/settings/channel.historyMessageLimit';
      confirmed({ body, method: 'PUT', url });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'PUT',
        payload: body,
        url,
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.assistantAction.updateMany).toHaveBeenCalledTimes(1);
    });

    it('refuses a write on a route that authenticates only after parsing, with no confirmation', async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'PUT',
        payload: { value: 30 },
        url: '/api/v1/platform/config/settings/channel.historyMessageLimit',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_REQUIRED');
      expect(seen).toEqual([]);
    });

    it('spends a confirmation once when requireAuth runs twice on the request', async () => {
      const body = { isActive: false };
      const url = `/api/v1/repositories/${RUN_ID}`;
      confirmed({ body, method: 'PATCH', url });
      const res = await app.inject({
        headers: { authorization: assistantBearer(app), 'x-assistant-action': ACTION_ID },
        method: 'PATCH',
        payload: body,
        url,
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.assistantAction.updateMany).toHaveBeenCalledTimes(1);
    });

    it('asks nothing of the person themselves', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: WORK_REQUEST,
        url: '/api/v1/work-requests',
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });
  });

  it('rate-limits the assistant by its user, not by the worker’s address', () => {
    const request = {
      headers: { authorization: assistantBearer(app) },
      ip: '10.0.0.5',
      server: app,
    } as unknown as FastifyRequest;
    expect(rateLimitKey(request)).toBe(`user:${USER_ID}`);
  });
});
