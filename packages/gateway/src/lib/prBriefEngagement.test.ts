import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  hostMatches: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('./repositoryHost.js', () => ({
  claimsHostWithOwnSecret: vi.fn(async () => false),
  deliveryHostMatches: m.hostMatches,
  webhookRepositoryWhere: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: async (_why: string, _models: string[], run: () => unknown) => run(),
}));

import { handleBriefEngagementDelivery } from './prBriefEngagement.js';

const BRIEF = {
  path: [
    { flagged: true, path: 'db/migrations/1.sql' },
    { flagged: false, path: 'src/a.ts' },
  ],
  skim: [{ path: 'src/old.ts' }],
};
const HEAD = 'a'.repeat(40);

const fastify = {
  prisma: {
    connection: { findMany: vi.fn(async () => [{ id: 'conn-1' }]) },
    prEvaluation: { findFirst: m.findFirst, updateMany: m.updateMany },
  },
} as unknown as FastifyInstance;
const log = { error: vi.fn() } as unknown as FastifyBaseLogger;

const base = {
  pull_request: { head: { sha: HEAD }, number: 7, user: { login: 'platform-user' } },
  repository: { full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets' },
  sender: { login: 'alice', type: 'User' },
};
const review = (state: string, over: Record<string, unknown> = {}) => ({
  ...base,
  action: 'submitted',
  review: { body: 'thanks', state },
  ...over,
});
const comment = (path: string, over: Record<string, unknown> = {}) => ({
  ...base,
  action: 'created',
  comment: { body: 'nit', path },
  ...over,
});
const deliver = (eventType: string, body: unknown) =>
  handleBriefEngagementDelivery(fastify, { body, eventType, log, verifiedHost: null });
const updates = () => m.updateMany.mock.calls.map(([args]) => args as Record<string, unknown>);

beforeEach(() => {
  m.findFirst.mockReset();
  m.findFirst.mockResolvedValue({ brief: BRIEF, id: 'row-1' });
  m.updateMany.mockReset();
  m.updateMany.mockResolvedValue({ count: 1 });
  m.hostMatches.mockReset();
  m.hostMatches.mockReturnValue(true);
  vi.mocked(log.error).mockReset();
});

describe('handleBriefEngagementDelivery: reviews', () => {
  it('stamps the first review once and counts a request for changes', async () => {
    await deliver('pull_request_review', review('changes_requested'));
    expect(m.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { connectionId: 'conn-1', headSha: HEAD, prNumber: 7 } })
    );
    expect(updates()).toEqual([
      {
        data: { firstHumanReviewAt: expect.any(Date) },
        where: { firstHumanReviewAt: null, id: 'row-1' },
      },
      { data: { changesRequestedCount: { increment: 1 } }, where: { id: 'row-1' } },
    ]);
  });

  it('counts an approval as a first review but not as a request for changes', async () => {
    await deliver('pull_request_review', review('approved'));
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ data: { firstHumanReviewAt: expect.any(Date) } });
  });

  it('ignores a dismissed or edited review', async () => {
    await deliver('pull_request_review', review('commented', { action: 'dismissed' }));
    await deliver('pull_request_review', review('commented', { action: 'edited' }));
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe('handleBriefEngagementDelivery: inline comments', () => {
  it.each([
    ['db/migrations/1.sql', 'commentsOnFlagged'],
    ['src/old.ts', 'commentsOnSkimmed'],
    ['src/a.ts', 'commentsElsewhere'],
    ['src/other.ts', 'commentsElsewhere'],
  ])('places a comment on %s under %s', async (path, column) => {
    await deliver('pull_request_review_comment', comment(path));
    expect(updates()).toEqual([{ data: { [column]: { increment: 1 } }, where: { id: 'row-1' } }]);
  });

  it('counts a created comment only', async () => {
    await deliver('pull_request_review_comment', comment('src/a.ts', { action: 'edited' }));
    await deliver('pull_request_review_comment', comment('src/a.ts', { action: 'deleted' }));
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe('handleBriefEngagementDelivery: whose act counts', () => {
  it.each([
    ['a bot type', { sender: { login: 'qodo', type: 'Bot' } }],
    ['a [bot] login', { sender: { login: 'app[bot]', type: 'User' } }],
    ['the pull request author', { sender: { login: 'Platform-User', type: 'User' } }],
    ['no sender', { sender: undefined }],
  ])('ignores %s', async (_name, over) => {
    await deliver('pull_request_review', review('changes_requested', over));
    await deliver('pull_request_review_comment', comment('src/a.ts', over));
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a comment or review that carries the platform marker', async () => {
    await deliver(
      'pull_request_review_comment',
      comment('src/a.ts', {
        comment: { body: 'x\n<!-- auto-swe:finding abc -->', path: 'src/a.ts' },
      })
    );
    await deliver(
      'pull_request_review',
      review('commented', {
        review: { body: '<!-- auto-swe:review-findings -->', state: 'commented' },
      })
    );
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe('handleBriefEngagementDelivery: scope and failure', () => {
  it('does nothing when no evaluation row exists for the head', async () => {
    m.findFirst.mockResolvedValue(null);
    await deliver('pull_request_review', review('approved'));
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing for another event, an unparsable body or a host that does not match', async () => {
    await deliver('issue_comment', comment('src/a.ts'));
    await deliver('pull_request_review', { nope: true });
    m.hostMatches.mockReturnValue(false);
    await deliver('pull_request_review', review('approved'));
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('never throws into the delivery: a failed write is logged and the next repository goes on', async () => {
    m.updateMany.mockRejectedValue(new Error('database unreachable'));
    await expect(deliver('pull_request_review', review('approved'))).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
