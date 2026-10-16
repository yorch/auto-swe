import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiCatalog } from '../lib/apiCatalog.js';
import { _resetAuthCachesForTests, requireAuth } from '../plugins/auth.js';
import { buildAssistantApp } from '../test/assistantApp.js';
import { assistantConversationRoutes } from './assistantConversations.js';

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: async () => true }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

/**
 * Conversations against real Postgres: a posted message writes the message, its reply and the
 * conversation in one transaction; the token handed to the workflow is accepted for exactly that
 * conversation's user and refused once the conversation is closed; one user never sees another's.
 *
 * Opt in with `ASSISTANT_PG_TEST=1` and a migrated, throwaway `DATABASE_URL`:
 *
 *   ASSISTANT_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/routes/assistantConversations.pg.test.ts
 */

const enabled = process.env.ASSISTANT_PG_TEST === '1';

const PREFIX = '/api/v1/assistant';

describe.skipIf(!enabled)('assistant conversations against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const userIds: string[] = [];
  const turns: Array<{ input: { conversationId: string }; turn: { token: string } }> = [];
  const namings: Array<{ conversationId: string; userId: string }> = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    _resetAuthCachesForTests();
    for (const who of ['a', 'b']) {
      const user = await prisma.user.create({
        data: { email: `conv-${who}-${suffix}@example.test`, emailVerified: true, name: who },
      });
      userIds.push(user.id);
    }
    app = await buildAssistantApp(prisma as never, async (a) => {
      a.decorate('temporal', {
        nameAssistantConversation: async (input: never) => {
          namings.push(input);
        },
        sendAssistantTurn: async (input: never, turn: never) => {
          turns.push({ input, turn });
        },
      } as never);
      await a.register(assistantConversationRoutes, { catalog: new ApiCatalog(), prefix: PREFIX });
      // A GET the policy admits, standing in for any route the assistant reads.
      a.get('/api/v1/workflow-runs', { onRequest: requireAuth() }, async () => ({ ok: true }));
    });
  });

  afterAll(async () => {
    await app?.close();
    // Cascades to the users' conversations and messages.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const person = (i: number) =>
    `Bearer ${app.auth.signAccessToken({ role: 'ENGINEER', sub: userIds[i] as string })}`;

  it('records a conversation, its message and an empty reply, and starts the turn', async () => {
    const res = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      payload: { message: 'How do I connect Slack?', pageContext: { route: '/studio' } },
      url: `${PREFIX}/conversations`,
    });
    expect(res.statusCode).toBe(201);
    const { conversation, reply } = res.json().data;
    const rows = await prisma.assistantMessage.findMany({
      orderBy: { createdAt: 'asc' },
      where: { conversationId: conversation.id },
    });
    expect(rows.map((r) => [r.role, r.status])).toEqual([
      ['USER', 'COMPLETE'],
      ['ASSISTANT', 'PENDING'],
    ]);
    expect(rows[1]?.id).toBe(reply.id);
    expect(rows[0]?.pageContext).toEqual({ route: '/studio' });
    expect(turns.at(-1)?.input.conversationId).toBe(conversation.id);
  });

  it("lets the turn's token read as its user, until the conversation is closed", async () => {
    const res = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      payload: { message: 'What is a run?' },
      url: `${PREFIX}/conversations`,
    });
    const conversationId = res.json().data.conversation.id as string;
    const token = turns.at(-1)?.turn.token as string;
    const read = () =>
      app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        url: '/api/v1/workflow-runs',
      });

    expect((await read()).statusCode).toBe(200);

    const closed = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      url: `${PREFIX}/conversations/${conversationId}/close`,
    });
    expect(closed.statusCode).toBe(200);
    _resetAuthCachesForTests();
    const after = await read();
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('TOKEN_INVALID');
  });

  it('records who titled a conversation: renamed by its user, then reset to automatic', async () => {
    const res = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      payload: { message: 'Why did   run 42\nfail?' },
      url: `${PREFIX}/conversations`,
    });
    const { conversation } = res.json().data;
    expect(conversation).toMatchObject({
      title: 'Why did run 42 fail?',
      titleSource: 'FIRST_MESSAGE',
    });

    const renamed = await app.inject({
      headers: { authorization: person(0) },
      method: 'PATCH',
      payload: { title: 'Run 42' },
      url: `${PREFIX}/conversations/${conversation.id}`,
    });
    expect(renamed.json().data).toMatchObject({ title: 'Run 42', titleSource: 'USER' });

    // Another user can neither rename nor reset it.
    for (const [method, url, payload] of [
      ['PATCH', `${PREFIX}/conversations/${conversation.id}`, { title: 'Mine' }],
      ['POST', `${PREFIX}/conversations/${conversation.id}/title/reset`, undefined],
    ] as const) {
      const other = await app.inject({
        headers: { authorization: person(1) },
        method,
        payload,
        url,
      });
      expect(other.statusCode, url).toBe(404);
    }

    const reset = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      url: `${PREFIX}/conversations/${conversation.id}/title/reset`,
    });
    expect(reset.json().data).toMatchObject({
      conversation: { title: 'Why did run 42 fail?', titleSource: 'FIRST_MESSAGE' },
      naming: true,
    });
    expect(namings.at(-1)).toEqual({ conversationId: conversation.id, userId: userIds[0] });
    const row = await prisma.assistantConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect([row.title, row.titleSource]).toEqual(['Why did run 42 fail?', 'FIRST_MESSAGE']);
  });

  it("never shows one user another's conversation", async () => {
    const res = await app.inject({
      headers: { authorization: person(0) },
      method: 'POST',
      payload: { message: 'Private question' },
      url: `${PREFIX}/conversations`,
    });
    const { conversation, reply } = res.json().data;
    for (const url of [
      `${PREFIX}/conversations/${conversation.id}`,
      `${PREFIX}/conversations/${conversation.id}/messages/${reply.id}/stream`,
    ]) {
      const other = await app.inject({ headers: { authorization: person(1) }, method: 'GET', url });
      expect(other.statusCode, url).toBe(404);
    }
    const posted = await app.inject({
      headers: { authorization: person(1) },
      method: 'POST',
      payload: { message: 'butting in' },
      url: `${PREFIX}/conversations/${conversation.id}/messages`,
    });
    expect(posted.statusCode).toBe(404);
    const list = await app.inject({
      headers: { authorization: person(1) },
      method: 'GET',
      url: `${PREFIX}/conversations`,
    });
    expect(list.json().data).toEqual([]);
  });
});
