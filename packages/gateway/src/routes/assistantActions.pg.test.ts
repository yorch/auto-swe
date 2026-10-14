import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetAuthCachesForTests, requireAuth } from '../plugins/auth.js';
import { buildAssistantApp } from '../test/assistantApp.js';
import { assistantActionRoutes } from './assistantActions.js';

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: async () => true }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

/**
 * A confirmation against real Postgres: proposed by the assistant, confirmed on the person's own
 * credential, spent by exactly one request — including when two arrive at once, which only the
 * conditional `UPDATE` decides and a mocked Prisma cannot show.
 *
 * Opt in with `ASSISTANT_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been run
 * against (it writes and deletes rows, so use a throwaway one):
 *
 *   ASSISTANT_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/routes/assistantActions.pg.test.ts
 */
const enabled = process.env.ASSISTANT_PG_TEST === '1';

const PREFIX = '/api/v1/assistant/actions';
const TARGET = '/api/v1/work-requests';
const BODY = { description: 'Add a health check', repoIds: ['r1'] };

describe.skipIf(!enabled)('assistant actions against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const conversationId = crypto.randomUUID();
  const otherConversationId = crypto.randomUUID();
  let userId: string;
  let app: FastifyInstance;
  let ran = 0;

  beforeAll(async () => {
    _resetAuthCachesForTests();
    const user = await prisma.user.create({
      data: { email: `assistant-${suffix}@example.test`, emailVerified: true, name: 'a' },
    });
    userId = user.id;
    // An assistant token is good only while its conversation is open and its user's.
    await prisma.assistantConversation.createMany({
      data: [
        { id: conversationId, title: 'one', userId },
        { id: otherConversationId, title: 'two', userId },
      ],
    });
    app = await buildAssistantApp(prisma as never, async (a) => {
      await a.register(assistantActionRoutes, { prefix: PREFIX });
      a.post(TARGET, { onRequest: requireAuth() }, async (request: FastifyRequest) => {
        ran += 1;
        return { actionId: request.assistant?.actionId };
      });
    });
  });

  afterAll(async () => {
    await app?.close();
    // Cascades to the user's conversations and assistant actions.
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  const assistant = (cid = conversationId) =>
    `Bearer ${app.auth.signAssistantToken({ conversationId: cid, userId })}`;
  const person = () => `Bearer ${app.auth.signAccessToken({ role: 'ENGINEER', sub: userId })}`;

  async function proposeAndConfirm(): Promise<string> {
    const proposed = await app.inject({
      headers: { authorization: assistant() },
      method: 'POST',
      payload: { body: BODY, method: 'POST', summary: 'Start a run', url: TARGET },
      url: PREFIX,
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().data.id as string;
    const confirmed = await app.inject({
      headers: { authorization: person() },
      method: 'POST',
      url: `${PREFIX}/${id}/confirm`,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.status).toBe('CONFIRMED');
    return id;
  }

  const execute = (id: string, authorization = assistant()) =>
    app.inject({
      headers: { authorization, 'x-assistant-action': id },
      method: 'POST',
      payload: BODY,
      url: TARGET,
    });

  it('runs the confirmed request once, then refuses it', async () => {
    const id = await proposeAndConfirm();
    ran = 0;
    const first = await execute(id);
    expect(first.statusCode).toBe(200);
    expect(first.json().actionId).toBe(id);
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('EXECUTED');
    expect(row.executedAt).not.toBeNull();

    const again = await execute(id);
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('ASSISTANT_CONFIRMATION_INVALID');
    expect(ran).toBe(1);
  });

  it('lets exactly one of two simultaneous requests spend a confirmation', async () => {
    const id = await proposeAndConfirm();
    ran = 0;
    const results = await Promise.all([execute(id), execute(id), execute(id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403, 403]);
    expect(ran).toBe(1);
  });

  it('refuses a confirmation from another conversation', async () => {
    const id = await proposeAndConfirm();
    const res = await execute(id, assistant(otherConversationId));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_INVALID');
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id } })).status).toBe(
      'CONFIRMED'
    );
  });

  it('refuses a confirmation that has lapsed', async () => {
    const id = await proposeAndConfirm();
    await prisma.assistantAction.update({
      data: { expiresAt: new Date(Date.now() - 1000) },
      where: { id },
    });
    const res = await execute(id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ASSISTANT_CONFIRMATION_INVALID');
  });

  it('cannot be answered twice', async () => {
    const id = await proposeAndConfirm();
    const declined = await app.inject({
      headers: { authorization: person() },
      method: 'POST',
      url: `${PREFIX}/${id}/decline`,
    });
    expect(declined.statusCode).toBe(409);
  });

  it('refuses every token of a conversation once it is closed', async () => {
    const closed = crypto.randomUUID();
    await prisma.assistantConversation.create({
      data: { closedAt: new Date(), id: closed, title: 'closed', userId },
    });
    const res = await app.inject({
      headers: { authorization: assistant(closed) },
      method: 'POST',
      payload: { body: BODY, method: 'POST', summary: 'Start a run', url: TARGET },
      url: PREFIX,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_INVALID');
  });
});
