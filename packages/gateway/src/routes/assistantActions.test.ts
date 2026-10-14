import { assistantActionDigest } from '@auto-swe/shared/lib/assistantAction';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAuthCachesForTests } from '../plugins/auth.js';
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
import { assistantActionRoutes } from './assistantActions.js';

const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: settings.resolveSetting }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

const PREFIX = '/api/v1/assistant/actions';
const PROPOSAL = {
  body: { description: 'Add a health check', repoIds: ['r1'] },
  method: 'POST',
  summary: 'Start a run for JIRA-12 on payments-api',
  url: '/api/v1/work-requests',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    body: PROPOSAL.body,
    conversationId: CONVERSATION_ID,
    createdAt: new Date('2026-10-14T10:00:00Z'),
    decidedAt: null,
    executedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    id: ACTION_ID,
    method: 'POST',
    status: 'PENDING',
    summary: PROPOSAL.summary,
    url: PROPOSAL.url,
    userId: USER_ID,
    ...overrides,
  };
}

describe('assistant action routes', () => {
  let app: FastifyInstance;
  let prisma: AssistantPrisma;

  beforeEach(async () => {
    _resetAuthCachesForTests();
    settings.resolveSetting.mockReset().mockResolvedValue(true);
    prisma = makeAssistantPrisma();
    app = await buildAssistantApp(prisma, async (a) => {
      await a.register(assistantActionRoutes, { prefix: PREFIX });
    });
  });
  afterEach(async () => {
    await app.close();
  });

  describe('POST / — propose', () => {
    it('records a pending proposal bound to the digest of the exact request', async () => {
      prisma.assistantAction.create.mockImplementation(async ({ data }) => row(data));
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        payload: PROPOSAL,
        url: PREFIX,
      });
      expect(res.statusCode).toBe(201);
      const data = prisma.assistantAction.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        conversationId: CONVERSATION_ID,
        method: 'POST',
        summary: PROPOSAL.summary,
        url: PROPOSAL.url,
        userId: USER_ID,
      });
      expect(data.digest).toBe(
        assistantActionDigest({ body: PROPOSAL.body, method: 'POST', url: PROPOSAL.url })
      );
      expect(res.json().data.status).toBe('PENDING');
    });

    it('needs no confirmation itself', async () => {
      prisma.assistantAction.create.mockImplementation(async ({ data }) => row(data));
      await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        payload: PROPOSAL,
        url: PREFIX,
      });
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });

    it('is the assistant’s alone', async () => {
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        payload: PROPOSAL,
        url: PREFIX,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_ONLY');
    });

    it.each([
      ['a route the assistant may never call', '/api/v1/human-steps/abc/respond'],
      ['a read, which needs no confirmation', '/api/v1/workflow-templates/validate'],
      ['a route that does not exist', '/api/v1/nowhere'],
    ])('refuses to propose %s', async (_name, url) => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        payload: { ...PROPOSAL, url },
        url: PREFIX,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('ASSISTANT_ACTION_NOT_CONFIRMABLE');
      expect(prisma.assistantAction.create).not.toHaveBeenCalled();
    });

    it('refuses a URL outside the API and a DELETE', async () => {
      for (const payload of [
        { ...PROPOSAL, url: 'https://evil.example/api/v1/work-requests' },
        { ...PROPOSAL, method: 'DELETE' },
      ]) {
        const res = await app.inject({
          headers: { authorization: assistantBearer(app) },
          method: 'POST',
          payload,
          url: PREFIX,
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('GET /:id', () => {
    it('shows the assistant only actions from its own conversation', async () => {
      prisma.assistantAction.findFirst.mockResolvedValue(row());
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'GET',
        url: `${PREFIX}/${ACTION_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.assistantAction.findFirst.mock.calls[0][0].where).toEqual({
        conversationId: CONVERSATION_ID,
        id: ACTION_ID,
        userId: USER_ID,
      });
    });

    it('shows the user any of their own actions, and reads a lapsed one as expired', async () => {
      prisma.assistantAction.findFirst.mockResolvedValue(
        row({ expiresAt: new Date(Date.now() - 1000) })
      );
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `${PREFIX}/${ACTION_ID}`,
      });
      expect(prisma.assistantAction.findFirst.mock.calls[0][0].where).toEqual({
        id: ACTION_ID,
        userId: USER_ID,
      });
      expect(res.json().data.status).toBe('EXPIRED');
    });

    it('answers 404 for anyone else’s', async () => {
      prisma.assistantAction.findFirst.mockResolvedValue(null);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'GET',
        url: `${PREFIX}/${ACTION_ID}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe.each([
    ['confirm', 'CONFIRMED'],
    ['decline', 'DECLINED'],
  ] as const)('POST /:id/%s', (verb, status) => {
    it(`lets the user ${verb} their own pending action, and audits it`, async () => {
      prisma.assistantAction.updateMany.mockResolvedValue({ count: 1 });
      prisma.assistantAction.findFirst.mockResolvedValue(row({ status }));
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url: `${PREFIX}/${ACTION_ID}/${verb}`,
      });
      expect(res.statusCode).toBe(200);
      const call = prisma.assistantAction.updateMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: ACTION_ID, status: 'PENDING', userId: USER_ID });
      expect(call.data.status).toBe(status);
      if (status === 'CONFIRMED') {
        // A confirmation is good for a short window, not the proposal's remaining hour.
        expect(call.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
      } else {
        expect(call.data.expiresAt).toBeUndefined();
      }
      expect(prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
        actorId: USER_ID,
        entityId: ACTION_ID,
        entityType: 'AssistantAction',
      });
    });

    it(`never lets the assistant ${verb}`, async () => {
      const res = await app.inject({
        headers: { authorization: assistantBearer(app) },
        method: 'POST',
        url: `${PREFIX}/${ACTION_ID}/${verb}`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ASSISTANT_NOT_ALLOWED');
      expect(prisma.assistantAction.updateMany).not.toHaveBeenCalled();
    });

    it('answers 409 for an action already answered or expired', async () => {
      prisma.assistantAction.updateMany.mockResolvedValue({ count: 0 });
      prisma.assistantAction.findFirst.mockResolvedValue(row({ status: 'DECLINED' }));
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url: `${PREFIX}/${ACTION_ID}/${verb}`,
      });
      expect(res.statusCode).toBe(409);
      expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it('answers 404 for an action that is not the user’s', async () => {
      prisma.assistantAction.updateMany.mockResolvedValue({ count: 0 });
      prisma.assistantAction.findFirst.mockResolvedValue(null);
      const res = await app.inject({
        headers: { authorization: personBearer(app) },
        method: 'POST',
        url: `${PREFIX}/${ACTION_ID}/${verb}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
