import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GATE = { mode: 'off', staleAfterHours: 0 } as const;
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 0 })),
}));

const m = vi.hoisted(() => ({
  loopOn: vi.fn(),
  postIssueComment: vi.fn(),
  postReview: vi.fn(),
  readPullFiles: vi.fn(),
  reviewerWrite: vi.fn(),
}));
vi.mock('@auto-swe/shared/config', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: m.loopOn,
}));
vi.mock('../lib/githubPullFiles.js', async (orig) => ({
  ...(await orig<typeof import('../lib/githubPullFiles.js')>()),
  readPullFiles: m.readPullFiles,
}));
vi.mock('../lib/githubReviewWrite.js', async (orig) => ({
  ...(await orig<typeof import('../lib/githubReviewWrite.js')>()),
  postIssueComment: m.postIssueComment,
  postReview: m.postReview,
}));
vi.mock('../lib/reviewerCredential.js', () => ({ resolveReviewerWrite: m.reviewerWrite }));

import { parseFeedbackCommand } from '@auto-swe/shared/automation';
import { reachableConnections } from '../lib/tenantScope.js';
import { pullRequestReviewRoutes, sendBackText } from './pullRequestReview.js';

const AUTH = { authorization: 'Bearer fake' };
const PR_ID = '00000000-0000-4000-8000-0000000000aa';
const REPO_ID = '00000000-0000-4000-8000-0000000000bb';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const HEAD = 'b'.repeat(40);
const PATCH = ['@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'].join('\n');
const DIGEST = 'a'.repeat(64);
const TOKEN = 'tok-secret';

type Role = 'ADMIN' | 'ENGINEER';

const repository = {
  githubApiUrl: null,
  githubUrl: 'https://github.com',
  id: REPO_ID,
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
};

const twoHunkFile = {
  additions: 3,
  deletions: 1,
  patch: [
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-gone',
    '+added',
    '@@ -20,3 +20,4 @@',
    ' x',
    '+y',
    ' z',
    ' w',
  ].join('\n'),
  patchDigest: DIGEST,
  path: 'src/a.ts',
};

const liveFiles = (over: Record<string, unknown> = {}) => ({
  files: [{ additions: 1, deletions: 0, patch: PATCH, patchDigest: DIGEST, path: 'src/a.ts' }],
  headSha: HEAD,
  state: 'open',
  truncated: false,
  type: 'ok',
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  body: 'use <=',
  id: D1,
  line: 2,
  patchDigest: DIGEST,
  path: 'src/a.ts',
  side: 'RIGHT',
  startLine: null,
  ...over,
});

async function buildApp(role: Role = 'ENGINEER') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const tx = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    prReviewDraft: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    prReviewDraft: { findMany: vi.fn().mockResolvedValue([draft()]) },
    pullRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: PR_ID, prNumber: 7, repository }),
    },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(pullRequestReviewRoutes, { prefix: '/api/v1/pull-requests' });
  await app.ready();
  return { app, prisma, tx };
}
type Built = Awaited<ReturnType<typeof buildApp>>;

const send = (b: Built, payload: unknown, id = PR_ID) =>
  b.app.inject({
    headers: AUTH,
    method: 'POST',
    payload: payload as never,
    url: `/api/v1/pull-requests/${id}/review`,
  });

const review = (over: Record<string, unknown> = {}) => ({
  body: 'Looks good with one change.',
  draftIds: [D1],
  event: 'COMMENT',
  headSha: HEAD,
  ...over,
});

beforeEach(() => {
  m.loopOn.mockReset();
  m.loopOn.mockResolvedValue(true);
  m.postIssueComment.mockReset();
  m.postIssueComment.mockResolvedValue({
    id: 55,
    type: 'ok',
    url: 'https://github.com/acme/api/pull/7#issuecomment-55',
  });
  m.postReview.mockReset();
  m.postReview.mockResolvedValue({
    id: 99,
    type: 'ok',
    url: 'https://github.com/acme/api/pull/7#pullrequestreview-99',
  });
  m.readPullFiles.mockReset();
  m.readPullFiles.mockResolvedValue(liveFiles());
  m.reviewerWrite.mockReset();
  m.reviewerWrite.mockResolvedValue({
    available: true,
    credential: { apiUrl: 'https://api.github.com', baseUrl: 'https://github.com', token: TOKEN },
  });
});

describe('POST /api/v1/pull-requests/:id/review', () => {
  describe('what is sent', () => {
    it("sends the caller's review with its drafts as line comments, pinned to the live head", async () => {
      const b = await buildApp();
      const res = await send(b, review({ event: 'REQUEST_CHANGES' }));
      expect(res.statusCode).toBe(200);
      expect(m.postReview).toHaveBeenCalledTimes(1);
      expect(m.postReview).toHaveBeenCalledWith(
        { apiUrl: 'https://api.github.com', token: TOKEN },
        { organizationName: 'acme', repoName: 'api' },
        7,
        {
          body: 'Looks good with one change.',
          comments: [{ body: 'use <=', line: 2, path: 'src/a.ts', side: 'RIGHT', startLine: null }],
          commitId: HEAD,
          event: 'REQUEST_CHANGES',
        }
      );
      expect(res.json().data).toEqual({
        comments: 1,
        draftsKept: false,
        event: 'REQUEST_CHANGES',
        reviewId: 99,
        url: 'https://github.com/acme/api/pull/7#pullrequestreview-99',
      });
    });

    it('never puts the token in the answer', async () => {
      const b = await buildApp();
      expect((await send(b, review())).body).not.toContain(TOKEN);
    });

    it('acts as the caller, with the credential they saved for this repository', async () => {
      const b = await buildApp();
      await send(b, review());
      expect(m.reviewerWrite).toHaveBeenCalledWith(b.prisma, {
        connectionId: REPO_ID,
        userId: 'user-1',
      });
    });

    it('passes a deleted-line comment and a range through with their side and start', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue(liveFiles({ files: [twoHunkFile] }));
      b.prisma.prReviewDraft.findMany.mockResolvedValue([
        draft({ line: 2, side: 'LEFT' }),
        draft({ id: D2, line: 22, startLine: 20 }),
      ]);
      const res = await send(b, review({ draftIds: [D1, D2] }));
      expect(res.statusCode).toBe(200);
      expect(m.postReview.mock.calls[0]?.[3].comments).toEqual([
        { body: 'use <=', line: 2, path: 'src/a.ts', side: 'LEFT', startLine: null },
        { body: 'use <=', line: 22, path: 'src/a.ts', side: 'RIGHT', startLine: 20 },
      ]);
    });

    it('trims the body and sends an approval with nothing else', async () => {
      const b = await buildApp();
      await send(b, review({ body: '  ', draftIds: [], event: 'APPROVE' }));
      expect(m.postReview.mock.calls[0]?.[3]).toEqual({
        body: '',
        comments: [],
        commitId: HEAD,
        event: 'APPROVE',
      });
    });

    it('sends a body-only comment', async () => {
      const b = await buildApp();
      await send(b, review({ draftIds: [], event: 'COMMENT' }));
      expect(m.postReview.mock.calls[0]?.[3]).toMatchObject({ comments: [], event: 'COMMENT' });
    });

    it('sends drafts alone as a comment review, with no body', async () => {
      const b = await buildApp();
      expect((await send(b, review({ body: undefined, event: 'COMMENT' }))).statusCode).toBe(200);
    });

    it('reads the drafts as the caller own them, on this pull request, in file order', async () => {
      const b = await buildApp();
      await send(b, review({ draftIds: [D1, D2] }));
      b.prisma.prReviewDraft.findMany.mockResolvedValue([draft()]);
      expect(b.prisma.prReviewDraft.findMany.mock.calls[0]?.[0]).toMatchObject({
        orderBy: [{ path: 'asc' }, { line: 'asc' }, { id: 'asc' }],
        where: { id: { in: [D1, D2] }, pullRequestId: PR_ID, userId: 'user-1' },
      });
    });

    it('names a draft once however many times it is listed', async () => {
      const b = await buildApp();
      await send(b, review({ draftIds: [D1, D1] }));
      expect(b.prisma.prReviewDraft.findMany.mock.calls[0]?.[0].where.id.in).toEqual([D1]);
    });

    it('accepts the head in any case', async () => {
      const b = await buildApp();
      expect((await send(b, review({ headSha: HEAD.toUpperCase() }))).statusCode).toBe(200);
    });
  });

  describe('what happens after it is sent', () => {
    it("deletes the drafts it sent, only the caller's, and audits the review without its text", async () => {
      const b = await buildApp();
      await send(b, review({ event: 'APPROVE' }));
      expect(b.tx.prReviewDraft.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [D1] }, pullRequestId: PR_ID, userId: 'user-1' },
      });
      const entry = b.tx.configAuditLog.create.mock.calls[0]?.[0].data;
      expect(entry).toMatchObject({
        action: 'CREATE',
        actorId: 'user-1',
        entityId: PR_ID,
        entityType: 'PullRequestReview',
      });
      expect(entry.afterJson).toEqual({
        comments: 1,
        event: 'APPROVE',
        githubReviewId: 99,
        hasBody: true,
        headSha: HEAD,
        kind: 'review',
        prNumber: 7,
        repositoryId: REPO_ID,
      });
      const written = JSON.stringify(entry);
      expect(written).not.toContain('Looks good');
      expect(written).not.toContain('use <=');
      expect(written).not.toContain(TOKEN);
    });

    it('still says it was sent, and which drafts are left, when recording it fails', async () => {
      const b = await buildApp();
      b.prisma.$transaction.mockRejectedValue(new Error('database down'));
      const res = await send(b, review());
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ draftsKept: true, reviewId: 99 });
      expect(m.postReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('what refuses it before the host is asked', () => {
    it.each(['disabled', 'no-token', 'unusable', 'unreadable'] as const)(
      'sends nothing when the caller cannot write as themselves (%s), and never falls back to the platform',
      async (reason) => {
        const b = await buildApp();
        m.reviewerWrite.mockResolvedValue({ available: false, reason });
        const res = await send(b, review());
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toMatchObject({
          code: 'NO_USER_CREDENTIAL',
          details: { reason },
        });
        expect(m.postReview).not.toHaveBeenCalled();
        expect(m.readPullFiles).not.toHaveBeenCalled();
      }
    );

    it('answers 404 for a pull request the caller cannot reach, and does nothing', async () => {
      const b = await buildApp('ENGINEER');
      b.prisma.pullRequest.findFirst.mockResolvedValue(null);
      expect((await send(b, review())).statusCode).toBe(404);
      expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({
        id: PR_ID,
        repository: reachableConnections({ sub: 'user-1' }, GATE),
      });
      expect(m.reviewerWrite).not.toHaveBeenCalled();
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('applies no reach filter for an admin', async () => {
      const b = await buildApp('ADMIN');
      await send(b, review());
      expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ id: PR_ID });
    });

    it.each([
      ['no repository', { id: PR_ID, prNumber: 7, repository: null }],
      ['no number', { id: PR_ID, prNumber: null, repository }],
      [
        'no owner',
        { id: PR_ID, prNumber: 7, repository: { ...repository, organizationName: null } },
      ],
      ['no name', { id: PR_ID, prNumber: 7, repository: { ...repository, repoName: null } }],
    ])('answers 404 for a pull request with %s', async (_name, row) => {
      const b = await buildApp();
      b.prisma.pullRequest.findFirst.mockResolvedValue(row);
      expect((await send(b, review())).statusCode).toBe(404);
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('needs a body to request changes', async () => {
      const b = await buildApp();
      const res = await send(b, review({ body: ' ', event: 'REQUEST_CHANGES' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('REVIEW_BODY_REQUIRED');
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('has nothing to send as a comment with no body and no drafts', async () => {
      const b = await buildApp();
      const res = await send(b, review({ body: '', draftIds: [], event: 'COMMENT' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NOTHING_TO_SEND');
    });

    it.each([
      ['carries the platform marker', 'fine <!-- auto-swe:brief -->'],
      ['would start a run', '/auto-swe fix'],
      ['is past the limit', 'x'.repeat(4001)],
    ])('refuses a body that %s', async (_name, body) => {
      const b = await buildApp();
      const res = await send(b, review({ body }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('REVIEW_TEXT_REFUSED');
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('refuses when a draft it names is gone or not the caller’s', async () => {
      const b = await buildApp();
      const res = await send(b, review({ draftIds: [D1, D2] }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DRAFTS_CHANGED');
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it.each([
      ['draftIds that are not uuids', { draftIds: ['nope'] }],
      ['more than a hundred drafts', { draftIds: Array.from({ length: 101 }, () => D1) }],
      ['an event that is not one', { event: 'DISMISS' }],
      ['no event', { event: undefined }],
      ['a head that is not a commit id', { headSha: 'main' }],
      ['no head', { headSha: undefined }],
    ])('rejects %s before reading anything', async (_name, over) => {
      const b = await buildApp();
      expect((await send(b, review(over))).statusCode).toBe(400);
      expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
    });

    it('rejects an id that is not a uuid', async () => {
      const b = await buildApp();
      expect((await send(b, review(), 'nope')).statusCode).toBe(400);
    });
  });

  describe('what refuses it once the host has been read', () => {
    it('sends nothing when the pull request cannot be read', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue({ reason: 'rate-limited', type: 'unavailable' });
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'FILES_UNAVAILABLE',
        details: { reason: 'rate-limited' },
      });
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('sends nothing to a pull request that is no longer open', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue(liveFiles({ state: 'closed' }));
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PULL_REQUEST_NOT_OPEN');
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('sends nothing when the head has moved, and says where it is now', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue(liveFiles({ headSha: 'd'.repeat(40) }));
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'STALE_HEAD',
        details: { currentHeadSha: 'd'.repeat(40) },
      });
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it.each([
      ['its file changed since it was written', draft({ patchDigest: 'b'.repeat(64) })],
      ['its line is no longer in the patch', draft({ line: 40 })],
      ['its file is no longer changed', draft({ path: 'src/gone.ts' })],
    ])('sends nothing when a draft is outdated because %s, and names it', async (_name, row) => {
      const b = await buildApp();
      b.prisma.prReviewDraft.findMany.mockResolvedValue([row]);
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'DRAFTS_OUTDATED',
        details: { draftIds: [D1] },
      });
      expect(m.postReview).not.toHaveBeenCalled();
      expect(b.tx.prReviewDraft.deleteMany).not.toHaveBeenCalled();
    });

    it('sends nothing when a comment on the old side is past the lines the old file has there', async () => {
      const b = await buildApp();
      b.prisma.prReviewDraft.findMany.mockResolvedValue([draft({ line: 3, side: 'LEFT' })]);
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'DRAFTS_OUTDATED' });
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('sends nothing when a range crosses hunks', async () => {
      const b = await buildApp();
      m.readPullFiles.mockResolvedValue(liveFiles({ files: [twoHunkFile] }));
      b.prisma.prReviewDraft.findMany.mockResolvedValue([draft({ line: 21, startLine: 2 })]);
      const res = await send(b, review());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({ draftIds: [D1] });
      expect(m.postReview).not.toHaveBeenCalled();
    });

    it('sends nothing at all when only one of several drafts is outdated', async () => {
      const b = await buildApp();
      b.prisma.prReviewDraft.findMany.mockResolvedValue([draft(), draft({ id: D2, line: 40 })]);
      const res = await send(b, review({ draftIds: [D1, D2] }));
      expect(res.json().error.details).toEqual({ draftIds: [D2] });
      expect(m.postReview).not.toHaveBeenCalled();
    });
  });

  describe('when the host refuses', () => {
    it.each([
      ['forbidden', 'HOST_FORBIDDEN'],
      ['not-found', 'HOST_NOT_FOUND'],
      ['rate-limited', 'HOST_RATE_LIMITED'],
      ['rejected', 'HOST_REJECTED'],
      ['unknown', 'OUTCOME_UNKNOWN'],
    ] as const)(
      'answers 502 %s as %s, and keeps the drafts and records nothing',
      async (reason, code) => {
        const b = await buildApp();
        m.postReview.mockResolvedValue({ reason, type: 'failed' });
        const res = await send(b, review());
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toMatchObject({ code, details: { reason } });
        expect(b.tx.prReviewDraft.deleteMany).not.toHaveBeenCalled();
        expect(b.tx.configAuditLog.create).not.toHaveBeenCalled();
      }
    );

    it('says an unknown outcome in words, and does not send a second time', async () => {
      const b = await buildApp();
      m.postReview.mockResolvedValue({ reason: 'unknown', type: 'failed' });
      const res = await send(b, review());
      expect(res.json().error.message).toContain('may or may not have been sent');
      expect(m.postReview).toHaveBeenCalledTimes(1);
    });
  });
});

describe('sendBackText', () => {
  it('is the command alone when there is no note', () => {
    expect(sendBackText('')).toBe('/auto-swe fix');
  });

  it('is read by the feedback loop as the command, with the note as its notes', () => {
    expect(parseFeedbackCommand(sendBackText(''))).toEqual({ notes: '' });
    expect(parseFeedbackCommand(sendBackText('Handle the empty list.'))).toEqual({
      notes: 'Handle the empty list.',
    });
    expect(parseFeedbackCommand(sendBackText('line one\nline two'))).toEqual({
      notes: 'line one\nline two',
    });
  });
});

describe('POST /api/v1/pull-requests/:id/send-back', () => {
  const sendBack = (b: Built, payload: unknown, id = PR_ID) =>
    b.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: payload as never,
      url: `/api/v1/pull-requests/${id}/send-back`,
    });
  const body = (over: Record<string, unknown> = {}) => ({ headSha: HEAD, ...over });

  it('leaves /auto-swe fix on the pull request as the caller, with their own token', async () => {
    const b = await buildApp();
    const res = await sendBack(b, body());
    expect(res.statusCode).toBe(200);
    expect(m.postIssueComment).toHaveBeenCalledTimes(1);
    expect(m.postIssueComment).toHaveBeenCalledWith(
      { apiUrl: 'https://api.github.com', token: TOKEN },
      { organizationName: 'acme', repoName: 'api' },
      7,
      '/auto-swe fix'
    );
    expect(m.reviewerWrite).toHaveBeenCalledWith(b.prisma, {
      connectionId: REPO_ID,
      userId: 'user-1',
    });
    expect(res.json().data).toEqual({
      commentId: 55,
      url: 'https://github.com/acme/api/pull/7#issuecomment-55',
    });
    expect(res.body).not.toContain(TOKEN);
  });

  it('carries a note after the command', async () => {
    const b = await buildApp();
    await sendBack(b, body({ note: '  Handle the empty list.  ' }));
    expect(m.postIssueComment.mock.calls[0]?.[3]).toBe('/auto-swe fix\n\nHandle the empty list.');
  });

  it.each([
    ['carries the platform marker', 'x <!-- auto-swe:brief -->'],
    ['would be a second command', '/auto-swe fix again'],
    ['is past the limit', 'x'.repeat(4001)],
  ])('refuses a note that %s', async (_name, note) => {
    const b = await buildApp();
    const res = await sendBack(b, body({ note }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REVIEW_TEXT_REFUSED');
    expect(m.postIssueComment).not.toHaveBeenCalled();
  });

  it('asks whether the feedback automations are on at the repository’s scope, and sends nothing when off', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findFirst.mockResolvedValue({
      id: PR_ID,
      prNumber: 7,
      repository: { ...repository, team: { orgId: 'org-1' }, teamId: 'team-1' },
    });
    m.loopOn.mockResolvedValue(false);
    const res = await sendBack(b, body());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEEDBACK_LOOP_OFF');
    expect(m.loopOn).toHaveBeenCalledWith('github.prFeedbackAutomationsEnabled', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
    expect(m.postIssueComment).not.toHaveBeenCalled();
    expect(m.reviewerWrite).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'no-token', 'unusable', 'unreadable'] as const)(
    'sends nothing when the caller cannot write as themselves (%s), and never uses the platform’s identity',
    async (reason) => {
      const b = await buildApp();
      m.reviewerWrite.mockResolvedValue({ available: false, reason });
      const res = await sendBack(b, body());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NO_USER_CREDENTIAL');
      expect(m.postIssueComment).not.toHaveBeenCalled();
    }
  );

  it('sends nothing to a pull request that is closed, or whose head has moved', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue(liveFiles({ state: 'merged' }));
    expect((await sendBack(b, body())).json().error.code).toBe('PULL_REQUEST_NOT_OPEN');
    m.readPullFiles.mockResolvedValue(liveFiles({ headSha: 'd'.repeat(40) }));
    expect((await sendBack(b, body())).json().error).toMatchObject({
      code: 'STALE_HEAD',
      details: { currentHeadSha: 'd'.repeat(40) },
    });
    expect(m.postIssueComment).not.toHaveBeenCalled();
  });

  it('sends nothing when the pull request cannot be read', async () => {
    const b = await buildApp();
    m.readPullFiles.mockResolvedValue({ reason: 'failed', type: 'unavailable' });
    expect((await sendBack(b, body())).json().error.code).toBe('FILES_UNAVAILABLE');
    expect(m.postIssueComment).not.toHaveBeenCalled();
  });

  it('answers 404 for a pull request the caller cannot reach, and does nothing', async () => {
    const b = await buildApp('ENGINEER');
    b.prisma.pullRequest.findFirst.mockResolvedValue(null);
    expect((await sendBack(b, body())).statusCode).toBe(404);
    expect(b.prisma.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: PR_ID,
      repository: reachableConnections({ sub: 'user-1' }, GATE),
    });
    expect(m.loopOn).not.toHaveBeenCalled();
    expect(m.postIssueComment).not.toHaveBeenCalled();
  });

  it('answers 404 for a pull request with no place on the host', async () => {
    const b = await buildApp();
    b.prisma.pullRequest.findFirst.mockResolvedValue({ id: PR_ID, prNumber: null, repository });
    expect((await sendBack(b, body())).statusCode).toBe(404);
  });

  it.each([
    ['forbidden', 'HOST_FORBIDDEN'],
    ['not-found', 'HOST_NOT_FOUND'],
    ['rate-limited', 'HOST_RATE_LIMITED'],
    ['rejected', 'HOST_REJECTED'],
    ['unknown', 'OUTCOME_UNKNOWN'],
  ] as const)('answers 502 %s as %s and records nothing', async (reason, code) => {
    const b = await buildApp();
    m.postIssueComment.mockResolvedValue({ reason, type: 'failed' });
    const res = await sendBack(b, body());
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code, details: { reason } });
    expect(b.prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('records it, without the note or the token', async () => {
    const b = await buildApp();
    await sendBack(b, body({ note: 'Handle the empty list.' }));
    const entry = b.prisma.configAuditLog.create.mock.calls[0]?.[0].data;
    expect(entry).toMatchObject({
      action: 'CREATE',
      actorId: 'user-1',
      entityId: PR_ID,
      entityType: 'PullRequestReview',
    });
    expect(entry.afterJson).toEqual({
      githubCommentId: 55,
      hasNote: true,
      headSha: HEAD,
      kind: 'send-back',
      prNumber: 7,
      repositoryId: REPO_ID,
    });
    expect(JSON.stringify(entry)).not.toContain('empty list');
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it('still says it was sent when recording it fails', async () => {
    const b = await buildApp();
    b.prisma.configAuditLog.create.mockRejectedValue(new Error('database down'));
    const res = await sendBack(b, body());
    expect(res.statusCode).toBe(200);
    expect(m.postIssueComment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a head that is not a commit id', { headSha: 'main' }],
    ['no head', { headSha: undefined }],
  ])('rejects %s before reading anything', async (_name, over) => {
    const b = await buildApp();
    expect((await sendBack(b, body(over))).statusCode).toBe(400);
    expect(b.prisma.pullRequest.findFirst).not.toHaveBeenCalled();
  });
});
