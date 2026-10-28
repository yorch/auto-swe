import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  branchHeadSha: vi.fn(async () => null as string | null),
  countFire: vi.fn(async () => 0),
  createBranch: vi.fn(async () => 'created' as string),
  deleteBranch: vi.fn(async () => true),
  findFire: vi.fn(async () => null as unknown),
  findPr: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRun: vi.fn(async () => null as unknown),
  findRunInput: vi.fn(async () => null as unknown),
  findUser: vi.fn(async (..._a: unknown[]) => null as { id: string } | null),
  getIssueComment: vi.fn(async () => null as unknown),
  getPullRequestReview: vi.fn(async () => null as unknown),
  getReviewComment: vi.fn(async () => null as unknown),
  isMember: true as boolean,
  listReviewThreads: vi.fn(async () => [] as unknown[]),
  pullRequestInfo: vi.fn(async () => null as unknown),
  repoPermission: vi.fn(async (..._a: unknown[]) => ({ ok: true, permission: 'write' }) as unknown),
  screen: vi.fn(async () => new Set<number>()),
  settings: { 'github.prFeedbackOtherPullRequestsEnabled': false } as Record<string, unknown>,
  workflowId: 'prfb-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: { count: m.countFire, findFirst: m.findFire },
    connection: { findUniqueOrThrow: m.findRepo },
    pullRequest: { findFirst: m.findPr },
    runInput: { findUnique: m.findRunInput },
    user: { findFirst: m.findUser },
    workflowRun: { findFirst: m.findRun },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key] ?? false),
}));
vi.mock('@auto-swe/shared/lib/repoMembership', () => ({
  isRepoMember: vi.fn(() => m.isMember),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => {
    if (m.workflowId === undefined) {
      throw new Error('Activity context is not available');
    }
    return { workflowExecution: { workflowId: m.workflowId } };
  },
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => true) }));
vi.mock('../lib/execUtils.js', () => ({
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
vi.mock('../lib/ciLogGuard.js', async (orig) => ({
  ...(await orig<typeof import('../lib/ciLogGuard.js')>()),
  feedbackInjectionScreen: m.screen,
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    branchHeadSha: m.branchHeadSha,
    createBranch: m.createBranch,
    deleteBranch: m.deleteBranch,
    getIssueComment: m.getIssueComment,
    getPullRequestReview: m.getPullRequestReview,
    getReviewComment: m.getReviewComment,
    listReviewThreads: m.listReviewThreads,
    pullRequestInfo: m.pullRequestInfo,
    repoPermission: m.repoPermission,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { gatherPrFeedback } from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const HEAD = 'a'.repeat(40);
const HEAD_REF = 'feature/work';
const WID = 'prfb-wf-1';

function request(over: Record<string, unknown> = {}): RepoWorkRequest {
  return {
    description: 'do not trust me',
    externalTicketId: 'prfb-9-777',
    payload: {
      baseBranch: HEAD_REF,
      connectionId: CONN,
      feedbackEventId: '777',
      feedbackEventKind: 'review',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'changes_requested',
      maxRounds: 5,
      pullRequestNumber: 9,
      ...over,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  } as unknown as RepoWorkRequest;
}

const fire = (over: Record<string, unknown> = {}) => ({
  automation: { connectionId: CONN, source: 'github.pull_request.feedback', templateId: null },
  createdAt: new Date('2026-10-20T00:00:00Z'),
  outcome: 'STARTED',
  ownerKey: 'github.com/acme/api',
  source: 'github.pull_request.feedback',
  temporalWorkflowId: WID,
  workRequestId: 'wr-1',
  ...over,
});
const repoRow = {
  id: CONN,
  organizationName: 'acme',
  repoName: 'api',
  team: { orgId: 'org-1' },
  teamId: 'team-1',
};
const openPr = {
  headRef: HEAD_REF,
  headRepositoryFullName: 'acme/api',
  headSha: HEAD,
  state: 'open',
};
const review = (body = 'please fix') => ({
  authorId: '42',
  authorLogin: 'reviewer',
  authorType: 'User',
  body,
  state: 'changes_requested',
});
const runInputRow = {
  requestedBy: { githubLoginAccountId: '42', id: 'user-1', isActive: true },
};
const prRow = (status: string | null) => ({
  workflow: { currentStatus: status, temporalWorkflowId: 'wf-original' },
  // A non-null workflow needs the original run for origin; test supplies via findRun.
});
const runRow = {
  template: { origin: 'WORKFLOW', teamId: 'team-1' },
  workRequest: { description: 'original task', payload: {} },
};

function thread(
  id: string,
  opener: Record<string, unknown>,
  replies: Record<string, unknown>[] = []
) {
  return {
    comments: [
      {
        authorId: '42',
        authorLogin: 'reviewer',
        authorType: 'User',
        body: 'fix this',
        createdAt: '2026-10-20T00:00:01Z',
        databaseId: 101,
        reviewDatabaseId: 700,
        ...opener,
      },
      ...replies.map((r, i) => ({
        authorId: '42',
        authorLogin: 'reviewer',
        authorType: 'User',
        body: 'ok',
        createdAt: `2026-10-20T00:00:0${i + 2}Z`,
        databaseId: 200 + i,
        reviewDatabaseId: 700,
        ...r,
      })),
    ],
    isOutdated: false,
    isResolved: false,
    line: 3,
    path: 'src/a.ts',
    threadId: id,
  };
}

function base() {
  m.findFire.mockResolvedValue(fire());
  m.findRepo.mockResolvedValue(repoRow);
  m.pullRequestInfo.mockResolvedValue(openPr);
  m.getPullRequestReview.mockResolvedValue(review());
  m.findRunInput.mockResolvedValue(runInputRow);
  m.findUser.mockResolvedValue({ id: 'user-1' });
  const row = prRow('COMPLETED');
  m.findPr.mockResolvedValue(row);
  m.findRun.mockResolvedValue(runRow);
  m.countFire.mockResolvedValue(0);
  m.listReviewThreads.mockResolvedValue([]);
}

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.isMember = true;
  m.settings['github.prFeedbackOtherPullRequestsEnabled'] = false;
  m.workflowId = WID;
  m.branchHeadSha.mockResolvedValue(null);
  m.createBranch.mockResolvedValue('created');
  m.deleteBranch.mockResolvedValue(true);
  m.findFire.mockResolvedValue(null);
  m.findPr.mockResolvedValue(null);
  m.findRepo.mockResolvedValue(null);
  m.findRun.mockResolvedValue(null);
  m.findRunInput.mockResolvedValue(null);
  m.findUser.mockResolvedValue(null);
  m.countFire.mockResolvedValue(0);
  m.getIssueComment.mockResolvedValue(null);
  m.getPullRequestReview.mockResolvedValue(null);
  m.getReviewComment.mockResolvedValue(null);
  m.listReviewThreads.mockResolvedValue([]);
  m.pullRequestInfo.mockResolvedValue(null);
  m.repoPermission.mockResolvedValue({ ok: true, permission: 'write' });
  m.screen.mockResolvedValue(new Set<number>());
});

describe('gatherPrFeedback — authority', () => {
  it('refuses when no feedback fire started this run', async () => {
    m.findFire.mockResolvedValue(null);
    await expect(gatherPrFeedback({ request: request() })).rejects.toMatchObject({
      type: 'PR_FEEDBACK_NOT_AUTOMATION_RUN',
    });
  });
  it('refuses a fire of another source or another workflow id', async () => {
    m.findFire.mockResolvedValue(fire({ source: 'github.workflow_run.failed' }));
    await expect(gatherPrFeedback({ request: request() })).rejects.toMatchObject({
      type: 'PR_FEEDBACK_NOT_AUTOMATION_RUN',
    });
    m.findFire.mockResolvedValue(fire({ temporalWorkflowId: 'other-wf' }));
    await expect(gatherPrFeedback({ request: request() })).rejects.toMatchObject({
      type: 'PR_FEEDBACK_NOT_AUTOMATION_RUN',
    });
  });
  it('skips when the trigger author is not the recorded requester', async () => {
    base();
    m.findUser.mockResolvedValue({ id: 'someone-else' });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
  });
  it('skips when the requester is inactive, not a member, or read-only', async () => {
    base();
    m.findRunInput.mockResolvedValue({
      requestedBy: { githubLoginAccountId: '42', id: 'user-1', isActive: false },
    });
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
    m.findRunInput.mockResolvedValue(runInputRow);
    m.isMember = false;
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
    m.isMember = true;
    m.repoPermission.mockResolvedValue({ ok: true, permission: 'read' });
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
  });
});

describe('gatherPrFeedback — origin and the original run', () => {
  it('skips on origin mismatch with the payload', async () => {
    base();
    const r = await gatherPrFeedback({
      request: request({ feedbackOrigin: 'agent_run' }),
    });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
  });
  it('skips while the original run is active, proceeds when terminal or parked', async () => {
    base();
    m.findPr.mockResolvedValue(prRow('RUNNING'));
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('skip');
    m.findPr.mockResolvedValue(prRow('AWAITING_HUMAN_MERGE'));
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('fix');
    m.findPr.mockResolvedValue(prRow('FAILED'));
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('fix');
  });
  it('skips a human round at once, not silently and without polling, while the run works', async () => {
    base();
    m.getIssueComment.mockResolvedValue({
      authorId: '42',
      authorLogin: 'reviewer',
      authorType: 'User',
      body: '/auto-swe fix please',
      issueNumber: 9,
    });
    const reason = 'the run that opened this pull request is still working on it';
    for (const over of [{}, { feedbackEventKind: 'issue_comment', feedbackTrigger: 'command' }]) {
      m.findPr.mockClear();
      m.findPr.mockResolvedValue(prRow('AWAITING_CI'));
      expect(await gatherPrFeedback({ request: request(over) })).toMatchObject({
        decision: 'skip',
        reason,
        silent: false,
      });
      expect(m.findPr).toHaveBeenCalledTimes(1);
    }
  });
  it('other origin requires the command and the setting', async () => {
    base();
    m.findPr.mockResolvedValue(null);
    const r1 = await gatherPrFeedback({ request: request({ feedbackOrigin: 'other' }) });
    expect(r1).toMatchObject({ decision: 'skip', silent: true });
    const r2 = await gatherPrFeedback({
      request: request({
        feedbackEventKind: 'issue_comment',
        feedbackOrigin: 'other',
        feedbackTrigger: 'command',
      }),
    });
    m.getIssueComment.mockResolvedValue({
      authorId: '42',
      authorLogin: 'reviewer',
      authorType: 'User',
      body: '/auto-swe fix please',
      issueNumber: 9,
    });
    expect(r2).toMatchObject({ decision: 'skip', silent: true });
    const r3 = await gatherPrFeedback({
      request: request({
        feedbackEventKind: 'issue_comment',
        feedbackOrigin: 'other',
        feedbackTrigger: 'command',
      }),
    });
    expect(r3).toMatchObject({ decision: 'skip', silent: false });
    m.settings['github.prFeedbackOtherPullRequestsEnabled'] = true;
    const r4 = await gatherPrFeedback({
      request: request({
        feedbackEventKind: 'issue_comment',
        feedbackOrigin: 'other',
        feedbackTrigger: 'command',
      }),
    });
    expect(r4).toMatchObject({ decision: 'fix', fixer: 'reviewFixer', origin: 'other' });
  });
  it('counts only fires with a producedKey toward the round limit', async () => {
    base();
    m.countFire.mockResolvedValue(5);
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', reason: 'round limit reached' });
    expect(m.countFire).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ producedKey: { not: null }, scopeKey: 'pr-9' }),
      })
    );
  });
});

describe('gatherPrFeedback — threads and the brief', () => {
  it('includes only trusted comments; untrusted ones are counted', async () => {
    base();
    m.getPullRequestReview.mockResolvedValue(review(''));
    // opener untrusted on T2, trusted on T1
    m.repoPermission.mockImplementation(async (...a: unknown[]) => ({
      ok: true,
      permission: a[1] === 'reviewer' ? 'write' : 'none',
    }));
    m.findUser.mockImplementation(async (q: unknown) => {
      const where = (q as { where: { githubLoginAccountId: { in: string[] } } }).where;
      return where.githubLoginAccountId.in.includes('42') ? { id: 'user-1' } : null;
    });
    m.listReviewThreads.mockResolvedValue([
      thread('t1', { authorId: '42', authorLogin: 'reviewer' }),
      thread('t2', { authorId: '55', authorLogin: 'stranger' }, [
        { authorId: '42', authorLogin: 'reviewer', body: 'follow-up' },
      ]),
    ]);
    const r = await gatherPrFeedback({ request: request() });
    // T2's opener is untrusted → thread dropped; its trusted reply was counted as untrusted
    // because the thread itself is excluded.
    expect(r.decision).toBe('fix');
    expect(r.threads.map((t) => t.label)).toEqual(['T1']);
    expect(r.dropped.untrusted).toBeGreaterThan(0);
  });
  it('always keeps the trigger comment’s thread, filtered per comment', async () => {
    base();
    m.getPullRequestReview.mockResolvedValue(null);
    m.getReviewComment.mockResolvedValue({
      authorId: '42',
      authorLogin: 'reviewer',
      authorType: 'User',
      body: '/auto-swe fix',
      inReplyToId: 101,
      pullRequestNumber: 9,
    });
    m.repoPermission.mockImplementation(async (...a: unknown[]) => ({
      ok: true,
      permission: a[1] === 'stranger' ? 'none' : 'write',
    }));
    m.findUser.mockImplementation(async (q: unknown) => {
      const where = (q as { where: { githubLoginAccountId: { in: string[] } } }).where;
      return where.githubLoginAccountId.in.includes('42') ? { id: 'user-1' } : null;
    });
    const t = thread('tX', { authorId: '42', authorLogin: 'reviewer' }, [
      { authorId: '55', authorLogin: 'stranger', body: 'untrusted reply' },
    ]);
    t.comments[0].databaseId = 101;
    m.listReviewThreads.mockResolvedValue([t]);
    const r = await gatherPrFeedback({
      request: request({ feedbackEventKind: 'review_comment', feedbackTrigger: 'command' }),
    });
    expect(r.decision).toBe('fix');
    expect(r.threads).toHaveLength(1); // trigger thread kept despite an untrusted reply
    expect(r.brief).not.toContain('untrusted reply');
    expect(r.dropped.untrusted).toBe(1);
  });
  it('screens every body in one batch and drops screened comments', async () => {
    base();
    m.listReviewThreads.mockResolvedValue([thread('t1', {}, [{ body: 'evil' }])]);
    m.screen.mockResolvedValue(new Set([2])); // index 2 = the reply (0=notes,1=opener)
    const r = await gatherPrFeedback({ request: request() });
    expect(m.screen).toHaveBeenCalledTimes(1);
    expect(r.dropped.screened).toBe(1);
  });
  it('drops bot-authored comments (null authorId)', async () => {
    base();
    m.listReviewThreads.mockResolvedValue([
      thread('t1', { authorId: null, authorLogin: 'bot[bot]', authorType: 'Bot' }),
    ]);
    const r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(0);
    expect(r.dropped.untrusted).toBeGreaterThan(0);
  });
  it('fences the brief as review feedback', async () => {
    base();
    m.listReviewThreads.mockResolvedValue([thread('t1', {})]);
    const r = await gatherPrFeedback({ request: request() });
    expect(r.brief).toContain('<review-feedback>');
  });
});

describe('gatherPrFeedback — the work branch and fixer', () => {
  it('silently skips when the work branch would be the pull request’s own', async () => {
    base();
    m.pullRequestInfo.mockResolvedValue({ ...openPr, headRef: 'auto/prfb-9-777' });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
  });
  it('exists_same proceeds; exists_other is a non-silent skip', async () => {
    base();
    m.createBranch.mockResolvedValue('exists_same');
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('fix');
    m.createBranch.mockResolvedValue('exists_other');
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: false });
  });
  it('fixer is agent only for an agent_run origin that still carries agentRef', async () => {
    base();
    m.findPr.mockResolvedValue(prRow('COMPLETED'));
    m.findRun.mockResolvedValue({
      template: { origin: 'system:agent-run', teamId: null },
      workRequest: { description: 'orig task', payload: { agentRef: 'impl' } },
    });
    const a = await gatherPrFeedback({
      request: request({ feedbackOrigin: 'agent_run' }),
    });
    expect(a).toMatchObject({ agentRef: 'impl', fixer: 'agent', originalTask: 'orig task' });
    m.findRun.mockResolvedValue({
      template: { origin: 'system:agent-run', teamId: null },
      workRequest: { description: 'orig task', payload: {} },
    });
    const b = await gatherPrFeedback({
      request: request({ feedbackOrigin: 'agent_run' }),
    });
    expect(b.fixer).toBe('reviewFixer');
  });
});
