import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

const GATE = { mode: 'off', staleAfterHours: 0 } as const;
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));

import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestReviewRoutes } from './pullRequestReview.js';

const AUTH = { authorization: 'Bearer fake' };
const PR_ID = '00000000-0000-4000-8000-0000000000aa';
const DRAFT_ID = '00000000-0000-4000-8000-0000000000dd';
const SHA = 'c'.repeat(40);
const DIGEST = 'a'.repeat(64);

type Role = 'ADMIN' | 'ENGINEER';

const stored = (over: Record<string, unknown> = {}) => ({
  body: 'use <=',
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
  headSha: SHA,
  id: DRAFT_ID,
  line: 2,
  path: 'src/a.ts',
  ...over,
});

async function buildApp(role: Role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    prReviewDraft: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async (args: { data: Record<string, unknown> }) =>
        stored({ ...args.data, id: DRAFT_ID })
      ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(stored()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequest: { findFirst: vi.fn().mockResolvedValue({ id: PR_ID }) },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(pullRequestReviewRoutes, { prefix: '/api/v1/pull-requests' });
  await app.ready();
  return { app, prisma };
}
type Built = Awaited<ReturnType<typeof buildApp>>;

const url = (suffix = '', id = PR_ID) => `/api/v1/pull-requests/${id}/drafts${suffix}`;
const call = (b: Built, method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
  b.app.inject({ headers: AUTH, method, payload: payload as never, url: path });

const newDraft = (over: Record<string, unknown> = {}) => ({
  body: 'use <=',
  headSha: SHA,
  line: 2,
  patchDigest: DIGEST,
  path: 'src/a.ts',
  ...over,
});

describe('POST /api/v1/pull-requests/:id/drafts', () => {
  it("keeps the caller's comment, keyed to this pull request, and answers it", async () => {
    const b = await buildApp();
    const res = await call(b, 'POST', url(), newDraft());
    expect(res.statusCode).toBe(201);
    expect(b.prisma.prReviewDraft.create).toHaveBeenCalledWith({
      data: {
        body: 'use <=',
        headSha: SHA,
        line: 2,
        patchDigest: DIGEST,
        path: 'src/a.ts',
        pullRequestId: PR_ID,
        userId: 'user-1',
      },
    });
    expect(res.json().data).toEqual({
      body: 'use <=',
      createdAt: '2026-11-04T10:00:00.000Z',
      headSha: SHA,
      id: DRAFT_ID,
      line: 2,
      path: 'src/a.ts',
    });
  });

  it('limits an engineer to repositories they can reach, and answers 404 otherwise', async () => {
    const b = await buildApp('ENGINEER');
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    expect((await call(b, 'POST', url(), newDraft())).statusCode).toBe(404);
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: PR_ID,
      repository: reachableConnections({ sub: 'user-1' }, GATE),
    });
    expect(b.prisma.prReviewDraft.create).not.toHaveBeenCalled();
  });

  it('applies no reach filter for an admin', async () => {
    const b = await buildApp('ADMIN');
    await call(b, 'POST', url(), newDraft());
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ id: PR_ID });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '  \n '],
    ['past the limit', 'x'.repeat(4001)],
    ['carrying the platform marker', 'ok <!-- auto-swe:brief -->'],
    ['a command that starts a run', '/auto-swe fix'],
  ])('refuses a comment that is %s, and keeps nothing', async (_name, body) => {
    const b = await buildApp();
    const res = await call(b, 'POST', url(), newDraft({ body }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REVIEW_TEXT_REFUSED');
    expect(b.prisma.prReviewDraft.create).not.toHaveBeenCalled();
  });

  it('refuses the hundred and first draft', async () => {
    const b = await buildApp();
    b.prisma.prReviewDraft.count.mockResolvedValue(100);
    const res = await call(b, 'POST', url(), newDraft());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_DRAFTS');
    expect(b.prisma.prReviewDraft.create).not.toHaveBeenCalled();
  });

  it("counts only the caller's own drafts on this pull request against the limit", async () => {
    const b = await buildApp();
    await call(b, 'POST', url(), newDraft());
    expect(b.prisma.prReviewDraft.count).toHaveBeenCalledWith({
      where: { pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  it.each([
    ['no path', { path: '' }],
    ['a path past the key limit', { path: 'p'.repeat(501) }],
    ['line zero', { line: 0 }],
    ['a fractional line', { line: 1.5 }],
    ['a line past any file', { line: 10_000_001 }],
    ['a head that is not a commit id', { headSha: 'main' }],
    ['a short digest', { patchDigest: 'abc' }],
    ['an upper-case digest', { patchDigest: 'A'.repeat(64) }],
  ])('rejects %s before reading anything', async (_name, over) => {
    const b = await buildApp();
    expect((await call(b, 'POST', url(), newDraft(over))).statusCode).toBe(400);
    expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a uuid', async () => {
    const b = await buildApp();
    expect((await call(b, 'POST', url('', 'nope'), newDraft())).statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/pull-requests/:id/drafts/:draftId', () => {
  it("changes the text of the caller's own draft only", async () => {
    const b = await buildApp();
    const res = await call(b, 'PATCH', url(`/${DRAFT_ID}`), { body: 'better' });
    expect(res.statusCode).toBe(200);
    expect(b.prisma.prReviewDraft.updateMany).toHaveBeenCalledWith({
      data: { body: 'better' },
      where: { id: DRAFT_ID, pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  it("answers 404 for a draft that is not the caller's, or not on this pull request", async () => {
    const b = await buildApp();
    b.prisma.prReviewDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await call(b, 'PATCH', url(`/${DRAFT_ID}`), { body: 'better' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DRAFT_NOT_FOUND');
  });

  it('refuses text the draft route would refuse, and changes nothing', async () => {
    const b = await buildApp();
    const res = await call(b, 'PATCH', url(`/${DRAFT_ID}`), { body: '/auto-swe fix' });
    expect(res.statusCode).toBe(400);
    expect(b.prisma.prReviewDraft.updateMany).not.toHaveBeenCalled();
  });

  it('answers 404 for a pull request the caller cannot reach', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    expect((await call(b, 'PATCH', url(`/${DRAFT_ID}`), { body: 'x' })).statusCode).toBe(404);
    expect(b.prisma.prReviewDraft.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a draft id that is not a uuid', async () => {
    const b = await buildApp();
    expect((await call(b, 'PATCH', url('/nope'), { body: 'x' })).statusCode).toBe(400);
  });
});

describe('DELETE /api/v1/pull-requests/:id/drafts/:draftId', () => {
  it("discards the caller's own draft only", async () => {
    const b = await buildApp();
    const res = await call(b, 'DELETE', url(`/${DRAFT_ID}`));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ deleted: true });
    expect(b.prisma.prReviewDraft.deleteMany).toHaveBeenCalledWith({
      where: { id: DRAFT_ID, pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  it("answers 404 for a draft that is not the caller's", async () => {
    const b = await buildApp();
    b.prisma.prReviewDraft.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(b, 'DELETE', url(`/${DRAFT_ID}`))).statusCode).toBe(404);
  });

  it('answers 404 for a pull request the caller cannot reach, and deletes nothing', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    expect((await call(b, 'DELETE', url(`/${DRAFT_ID}`))).statusCode).toBe(404);
    expect(b.prisma.prReviewDraft.deleteMany).not.toHaveBeenCalled();
  });
});
