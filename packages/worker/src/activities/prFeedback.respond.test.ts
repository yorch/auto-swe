import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  countFire: vi.fn(async () => 0),
  findBuiltIn: vi.fn(async () => null as { id: string } | null),
  findFire: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRunInput: vi.fn(async () => null as unknown),
  listReviewThreads: vi.fn(async () => [] as unknown[]),
  modelCalled: vi.fn(),
  postedComments: [] as string[],
  replies: [] as { body: string; commentId: number }[],
  replyToReviewComment: vi.fn(async (..._a: unknown[]) => ({})),
  upsertMarkedComment: vi.fn(async (_r: unknown, _n: number, _k: string, body: string) => {
    m.postedComments.push(body);
    return {};
  }),
  workflowId: 'prfb-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: { count: m.countFire, findFirst: m.findFire },
    connection: { findUniqueOrThrow: m.findRepo },
    runInput: { findUnique: m.findRunInput },
    workflowTemplate: { findFirst: m.findBuiltIn },
  },
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
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async (x: unknown) => x),
}));
vi.mock('./runAgent.js', () => ({
  runAgent: vi.fn(async () => {
    m.modelCalled();
    return {
      object: {
        summary: 'fixed the thing',
        threads: [{ label: 'T1', note: 'done', outcome: 'addressed' }],
      },
    };
  }),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    listReviewThreads: m.listReviewThreads,
    replyToReviewComment: m.replyToReviewComment,
    upsertMarkedComment: m.upsertMarkedComment,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { type GatherResult, respondToPrFeedback } from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const BUILTIN = 'b0000000-0000-4000-8000-000000000000';
const WID = 'prfb-wf-1';

const request = (): RepoWorkRequest =>
  ({
    description: 'x',
    externalTicketId: 'prfb-9-777',
    payload: {
      baseBranch: 'feature/work',
      connectionId: CONN,
      feedbackEventId: '777',
      feedbackEventKind: 'review',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'changes_requested',
      pullRequestNumber: 9,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  }) as unknown as RepoWorkRequest;

const gather = (over: Record<string, unknown> = {}): GatherResult =>
  ({
    brief: '<review-feedback>[T1] src/a.ts:3 — @reviewer: fix this</review-feedback>',
    decision: 'fix',
    dropped: { overLimit: 0, screened: 0, untrusted: 0 },
    headRef: 'feature/work',
    headSha: 'a'.repeat(40),
    origin: 'workflow',
    prNumber: 999, // deliberately different: the comment must go to payload's number
    round: 1,
    silent: false,
    threads: [{ label: 'T1', line: 3, path: 'src/a.ts', replyToCommentId: 101, threadId: 't1' }],
    workBranch: 'auto/prfb-9-777',
    ...over,
  }) as unknown as GatherResult;

function base() {
  m.findFire.mockResolvedValue({
    automation: { connectionId: CONN, source: 'github.pull_request.feedback', templateId: null },
    createdAt: new Date('2026-10-20T00:00:00Z'),
    outcome: 'STARTED',
    ownerKey: 'github.com/acme/api',
    scopeKey: 'pr-9',
    source: 'github.pull_request.feedback',
    temporalWorkflowId: WID,
    workRequestId: 'wr-1',
  });
  m.findRunInput.mockResolvedValue({ launchedById: null, templateId: BUILTIN });
  m.findBuiltIn.mockResolvedValue({ id: BUILTIN });
  m.findRepo.mockResolvedValue({ id: CONN });
}

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.postedComments.length = 0;
  m.replies.length = 0;
  m.workflowId = WID;
  m.countFire.mockResolvedValue(0);
  m.listReviewThreads.mockResolvedValue([]);
});

describe('respondToPrFeedback — authority', () => {
  it('refuses silently when the fire is not this run’s', async () => {
    m.findFire.mockResolvedValue(null);
    const r = await respondToPrFeedback({ gather: gather(), request: request(), skipReason: 'x' });
    expect(r).toMatchObject({ commented: false });
    expect(m.upsertMarkedComment).not.toHaveBeenCalled();
  });
  it('posts to payload.pullRequestNumber, never gather.prNumber', async () => {
    base();
    await respondToPrFeedback({
      gather: gather(),
      request: request(),
      skipReason: 'round limit reached',
    });
    expect(m.upsertMarkedComment).toHaveBeenCalledWith(
      expect.anything(),
      9,
      expect.anything(),
      expect.anything()
    );
  });
});

describe('respondToPrFeedback — skip mode', () => {
  it('posts nothing on a silent skip', async () => {
    base();
    const r = await respondToPrFeedback({
      gather: gather({ silent: true }),
      request: request(),
      skipReason: 'the pull request is not open',
    });
    expect(r).toMatchObject({ commented: false, replies: 0 });
    expect(m.upsertMarkedComment).not.toHaveBeenCalled();
  });
  it('posts a neutralised reason with no setting names', async () => {
    base();
    await respondToPrFeedback({
      gather: gather(),
      request: request(),
      skipReason: 'this automation is not allowed to act on this pull request @admin <b>x</b>',
    });
    const body = m.postedComments[0];
    expect(body).not.toContain('@admin');
    expect(body).not.toContain('<b>');
  });
});

describe('respondToPrFeedback — verdict and replies', () => {
  it('replies once per thread with a marker; a retried call replies nowhere', async () => {
    base();
    m.replyToReviewComment.mockImplementation(async (...a: unknown[]) => {
      m.replies.push({ body: a[3] as string, commentId: a[2] as number });
      return {};
    });
    const r1 = await respondToPrFeedback({
      gather: gather(),
      push: { branch: 'feature/work', commitSha: 'c'.repeat(40), pushed: true },
      request: request(),
    });
    expect(m.modelCalled).toHaveBeenCalledTimes(1);
    expect(r1.replies).toBe(1);
    expect(m.replies[0].body).toContain(`auto-swe:pr-feedback-reply:${WID}`);
    // Second call: the thread now holds our reply marker → no reply, no extra summary.
    m.listReviewThreads.mockResolvedValue([
      {
        comments: [
          {
            body: `**auto-swe** — addressed. <!-- auto-swe:pr-feedback-reply:${WID} -->`,
            databaseId: 500,
          },
        ],
        threadId: 't1',
      },
    ]);
    const r2 = await respondToPrFeedback({
      gather: gather(),
      previous: r1.verdict,
      push: { branch: 'feature/work', commitSha: 'c'.repeat(40), pushed: true },
      request: request(),
    });
    expect(r2.replies).toBe(0);
    expect(m.modelCalled).toHaveBeenCalledTimes(1); // previous verdict: no model call
  });
  it('posts only the summary for a Qodo finding: it has no GitHub thread to reply on', async () => {
    base();
    m.replyToReviewComment.mockImplementation(async (...a: unknown[]) => {
      m.replies.push({ body: a[3] as string, commentId: a[2] as number });
      return {};
    });
    const r = await respondToPrFeedback({
      gather: gather({
        threads: [{ label: 'T1', line: null, path: '', replyToCommentId: 0, threadId: '' }],
      }),
      push: { branch: 'feature/work', commitSha: 'c'.repeat(40), pushed: true },
      request: request(),
    });
    expect(r).toMatchObject({ commented: true, replies: 0 });
    expect(m.replies).toHaveLength(0);
    expect(m.postedComments.length).toBeGreaterThan(0);
  });
  it('previous-verdict calls re-render summary with push + CI lines, no model call', async () => {
    base();
    const r = await respondToPrFeedback({
      ci: { detail: 'lint', verdict: 'failed' },
      gather: gather(),
      previous: { summary: 'earlier summary', threads: [] },
      push: { branch: 'feature/work', commitSha: 'd'.repeat(40), pushed: true },
      request: request(),
    });
    expect(m.modelCalled).not.toHaveBeenCalled();
    const body = m.postedComments[0];
    expect(body).toContain('earlier summary');
    expect(body).toContain('Pushed commit');
    expect(body).toContain('CI');
    expect(r.replies).toBe(0);
  });
  it('headRef is neutralised in the push line', async () => {
    base();
    await respondToPrFeedback({
      gather: gather({ headRef: 'feat @everyone <img>' }),
      previous: { summary: '', threads: [] },
      push: { branch: 'x', commitSha: 'c'.repeat(40), pushed: true },
      request: request(),
    });
    const body = m.postedComments[0];
    expect(body).not.toContain('@everyone');
    expect(body).not.toContain('<img>');
  });
  it('the newer-feedback line appears only when a later fire was suppressed in-flight', async () => {
    base();
    await respondToPrFeedback({
      gather: gather(),
      previous: { summary: 'x', threads: [] },
      request: request(),
    });
    expect(m.postedComments[0]).not.toContain('arrived after this round started');
    m.countFire.mockResolvedValue(1);
    await respondToPrFeedback({
      gather: gather(),
      previous: { summary: 'x', threads: [] },
      request: request(),
    });
    expect(m.postedComments[1]).toContain('arrived after this round started');
    expect(m.countFire).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outcome: 'SUPPRESSED_IN_FLIGHT', scopeKey: 'pr-9' }),
      })
    );
  });
});
