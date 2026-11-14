import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));

const m = vi.hoisted(() => ({
  findSentReview: vi.fn(),
  postReview: vi.fn(),
  reviewerWrite: vi.fn(),
}));
vi.mock('../lib/githubReviewRead.js', () => ({ findSentReview: m.findSentReview }));
vi.mock('../lib/githubReviewWrite.js', async (orig) => ({
  ...(await orig<typeof import('../lib/githubReviewWrite.js')>()),
  postReview: m.postReview,
}));
vi.mock('../lib/reviewerCredential.js', () => ({ resolveReviewerWrite: m.reviewerWrite }));

import { pullRequestReviewRoutes } from './pullRequestReview.js';

const AUTH = { authorization: 'Bearer fake' };
const PR_ID = '00000000-0000-4000-8000-0000000000aa';
const REPO_ID = '00000000-0000-4000-8000-0000000000bb';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const HEAD = 'b'.repeat(40);
const TOKEN = 'tok-secret';

const DRAFT_1 = {
  body: ' Rename this. ',
  id: D1,
  line: 12,
  path: 'src/a.ts',
  side: 'LEFT',
  startLine: 10,
};

const repository = {
  githubApiUrl: null,
  githubUrl: 'https://github.com',
  id: REPO_ID,
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
};

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    prReviewDraft: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    prReviewDraft: { findMany: vi.fn().mockResolvedValue([DRAFT_1]) },
    pullRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: PR_ID, prNumber: 7, repository }),
    },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
  } as unknown as never);
  await app.register(pullRequestReviewRoutes, { prefix: '/api/v1/pull-requests' });
  await app.ready();
  return { app, prisma, tx };
}
type Built = Awaited<ReturnType<typeof buildApp>>;

const check = (b: Built, payload: unknown, id = PR_ID) =>
  b.app.inject({
    headers: AUTH,
    method: 'POST',
    payload: payload as never,
    url: `/api/v1/pull-requests/${id}/review/check`,
  });

const attempt = (over: Record<string, unknown> = {}) => ({
  attemptedAt: new Date(Date.now() - 30_000).toISOString(),
  body: ' Looks good with one change. ',
  draftIds: [D1],
  event: 'COMMENT',
  headSha: HEAD,
  ...over,
});

beforeEach(() => {
  m.findSentReview.mockReset();
  m.findSentReview.mockResolvedValue({
    id: 99,
    type: 'found',
    url: 'https://github.com/acme/api/pull/7#pullrequestreview-99',
  });
  m.postReview.mockReset();
  m.reviewerWrite.mockReset();
  m.reviewerWrite.mockResolvedValue({
    available: true,
    credential: { apiUrl: 'https://api.github.com', baseUrl: 'https://github.com', token: TOKEN },
  });
});

describe('POST /api/v1/pull-requests/:id/review/check', () => {
  it('asks the host as the caller, with what the send carried, and never posts', async () => {
    const b = await buildApp();
    const body = attempt();
    expect((await check(b, body)).statusCode).toBe(200);
    expect(m.reviewerWrite).toHaveBeenCalledWith(b.prisma, {
      connectionId: REPO_ID,
      userId: 'user-1',
    });
    expect(m.findSentReview).toHaveBeenCalledTimes(1);
    expect(m.findSentReview).toHaveBeenCalledWith(
      { apiUrl: 'https://api.github.com', token: TOKEN },
      { organizationName: 'acme', repoName: 'api' },
      7,
      {
        attemptedAt: new Date(body.attemptedAt),
        body: 'Looks good with one change.',
        comments: [
          { body: ' Rename this. ', line: 12, path: 'src/a.ts', side: 'LEFT', startLine: 10 },
        ],
        event: 'COMMENT',
        headSha: HEAD,
      }
    );
    expect(m.postReview).not.toHaveBeenCalled();
  });

  it('reads the drafts as the caller owns them, on this pull request', async () => {
    const b = await buildApp();
    await check(b, attempt());
    expect(b.prisma.prReviewDraft.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: [D1] }, pullRequestId: PR_ID, userId: 'user-1' },
    });
  });

  describe('when the review is found', () => {
    it('deletes the drafts and audits once with confirmed, in one transaction', async () => {
      const b = await buildApp();
      const res = await check(b, attempt({ event: 'COMMENT' }));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        comments: 1,
        confirmed: true,
        draftsKept: false,
        event: 'COMMENT',
        reviewId: 99,
        status: 'found',
        url: 'https://github.com/acme/api/pull/7#pullrequestreview-99',
      });
      expect(b.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(b.tx.prReviewDraft.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [D1] }, pullRequestId: PR_ID, userId: 'user-1' },
      });
      expect(b.tx.configAuditLog.create).toHaveBeenCalledTimes(1);
      const entry = b.tx.configAuditLog.create.mock.calls[0]?.[0].data;
      expect(entry).toMatchObject({
        action: 'CREATE',
        actorId: 'user-1',
        entityId: PR_ID,
        entityType: 'PullRequestReview',
      });
      expect(entry.afterJson).toEqual({
        comments: 1,
        confirmed: true,
        event: 'COMMENT',
        githubReviewId: 99,
        hasBody: true,
        headSha: HEAD,
        kind: 'review',
        prNumber: 7,
        repositoryId: REPO_ID,
      });
      const written = JSON.stringify(entry);
      expect(written).not.toContain('Looks good');
      expect(written).not.toContain(TOKEN);
    });

    it('writes no second audit row for a review an audit row already names', async () => {
      const b = await buildApp();
      b.tx.configAuditLog.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'a1' });
      const first = await check(b, attempt());
      const second = await check(b, attempt());
      expect(first.json().data).toMatchObject({ confirmed: true, status: 'found' });
      expect(second.json().data).toMatchObject({
        confirmed: true,
        reviewId: 99,
        status: 'found',
      });
      expect(b.tx.configAuditLog.create).toHaveBeenCalledTimes(1);
      expect(b.tx.configAuditLog.findFirst).toHaveBeenCalledWith({
        select: { id: true },
        where: {
          afterJson: { equals: 99, path: ['githubReviewId'] },
          entityId: PR_ID,
          entityType: 'PullRequestReview',
        },
      });
      expect(b.tx.prReviewDraft.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('takes the pull request’s advisory lock before looking up the audit row', async () => {
      const b = await buildApp();
      await check(b, attempt());
      expect(b.tx.$executeRaw).toHaveBeenCalledTimes(1);
      const lock = b.tx.$executeRaw.mock.invocationCallOrder[0] as number;
      const lookup = b.tx.configAuditLog.findFirst.mock.invocationCallOrder[0] as number;
      const write = b.tx.configAuditLog.create.mock.invocationCallOrder[0] as number;
      expect(lock).toBeLessThan(lookup);
      expect(lookup).toBeLessThan(write);
      const [strings, ...values] = b.tx.$executeRaw.mock.calls[0] as [string[], ...string[]];
      expect(strings.join('?')).toContain('pg_advisory_xact_lock');
      expect(values.join('|')).toContain(PR_ID);
    });

    it('does not need the pull request to be open or the head to still match', async () => {
      const b = await buildApp();
      const res = await check(b, attempt({ headSha: 'e'.repeat(40) }));
      expect(res.statusCode).toBe(200);
      expect(m.findSentReview.mock.calls[0]?.[3].headSha).toBe('e'.repeat(40));
    });

    it('still says it was found, and that the drafts are left, when recording fails', async () => {
      const b = await buildApp();
      b.prisma.$transaction.mockRejectedValue(new Error('database down'));
      const res = await check(b, attempt());
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ draftsKept: true, reviewId: 99, status: 'found' });
    });

    it('sends nothing of the token in the answer', async () => {
      const b = await buildApp();
      expect((await check(b, attempt())).body).not.toContain(TOKEN);
    });
  });

  describe('when it is not found', () => {
    it('keeps the drafts, writes no audit and says it proves nothing', async () => {
      const b = await buildApp();
      m.findSentReview.mockResolvedValue({ type: 'not-found' });
      const res = await check(b, attempt());
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.status).toBe('not-found');
      expect(data.message).toContain('does not prove it was not sent');
      expect(b.prisma.$transaction).not.toHaveBeenCalled();
      expect(b.tx.prReviewDraft.deleteMany).not.toHaveBeenCalled();
      expect(b.tx.configAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('when the host cannot be read', () => {
    it.each([
      ['forbidden', 'HOST_FORBIDDEN'],
      ['not-found', 'HOST_NOT_FOUND'],
      ['rate-limited', 'HOST_RATE_LIMITED'],
      ['rejected', 'HOST_REJECTED'],
      ['unknown', 'OUTCOME_UNKNOWN'],
    ])('answers 502 %s as %s and changes nothing', async (reason, code) => {
      const b = await buildApp();
      m.findSentReview.mockResolvedValue({ reason, type: 'failed' });
      const res = await check(b, attempt());
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe(code);
      expect(b.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('what refuses it before the host is asked', () => {
    it('answers 409 NO_USER_CREDENTIAL, as a send does, and never falls back', async () => {
      const b = await buildApp();
      m.reviewerWrite.mockResolvedValue({ available: false, reason: 'no-token' });
      const res = await check(b, attempt());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NO_USER_CREDENTIAL');
      expect(res.json().error.details).toEqual({ reason: 'no-token' });
      expect(m.findSentReview).not.toHaveBeenCalled();
    });

    it('answers 409 DRAFTS_CHANGED when a named draft is gone', async () => {
      const b = await buildApp();
      const res = await check(b, attempt({ draftIds: [D1, D2] }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DRAFTS_CHANGED');
      expect(m.findSentReview).not.toHaveBeenCalled();
    });

    it('counts a draft once however many times it is listed', async () => {
      const b = await buildApp();
      expect((await check(b, attempt({ draftIds: [D1, D1] }))).statusCode).toBe(200);
      expect(m.findSentReview.mock.calls[0]?.[3].comments).toHaveLength(1);
    });

    it('answers 404 for a repository the caller cannot reach', async () => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue(null);
      expect((await check(b, attempt())).statusCode).toBe(404);
      expect(m.findSentReview).not.toHaveBeenCalled();
    });

    it('answers 404 for a pull request with no place on the host', async () => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue({ id: PR_ID, prNumber: null, repository });
      expect((await check(b, attempt())).statusCode).toBe(404);
    });

    it('answers 400 when the send is too old', async () => {
      const b = await buildApp();
      const old = new Date(Date.now() - 61 * 60_000).toISOString();
      const res = await check(b, attempt({ attemptedAt: old }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ATTEMPT_TIME_INVALID');
      expect(m.findSentReview).not.toHaveBeenCalled();
    });

    it('clamps a send dated in the future to the server clock instead of refusing it', async () => {
      const b = await buildApp();
      const before = Date.now();
      const ahead = new Date(before + 5 * 60_000).toISOString();
      const res = await check(b, attempt({ attemptedAt: ahead }));
      expect(res.statusCode).toBe(200);
      const sent = m.findSentReview.mock.calls[0]?.[3].attemptedAt as Date;
      expect(sent.getTime()).toBeGreaterThanOrEqual(before);
      expect(sent.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('refuses what a send refuses: nothing to send', async () => {
      const b = await buildApp();
      const res = await check(b, attempt({ body: '  ', draftIds: [] }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NOTHING_TO_SEND');
      expect(m.findSentReview).not.toHaveBeenCalled();
      expect(m.reviewerWrite).not.toHaveBeenCalled();
    });

    it('refuses what a send refuses: requesting changes with no text', async () => {
      const b = await buildApp();
      const res = await check(b, attempt({ body: '', event: 'REQUEST_CHANGES' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('REVIEW_BODY_REQUIRED');
      expect(m.findSentReview).not.toHaveBeenCalled();
    });

    it('accepts a Z time, with or without milliseconds, and refuses an offset as before', async () => {
      const b = await buildApp();
      const at = new Date(Date.now() - 30_000);
      const iso = at.toISOString();
      expect((await check(b, attempt({ attemptedAt: iso }))).statusCode).toBe(200);
      const whole = iso.replace(/\.\d+Z$/, 'Z');
      expect((await check(b, attempt({ attemptedAt: whole }))).statusCode).toBe(200);
      const offset = iso.replace('Z', '+00:00');
      expect((await check(b, attempt({ attemptedAt: offset }))).statusCode).toBe(400);
    });

    it('answers 400 for a time that is not a datetime or a missing one', async () => {
      const b = await buildApp();
      expect((await check(b, attempt({ attemptedAt: 'yesterday' }))).statusCode).toBe(400);
      expect((await check(b, attempt({ attemptedAt: undefined }))).statusCode).toBe(400);
    });
  });
});
