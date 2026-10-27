import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeQodoFindingsClient,
  type QodoFinding,
  type QodoPrReviewState,
} from '../lib/qodo/client.js';

const m = vi.hoisted(() => ({
  client: undefined as unknown,
  countFire: vi.fn(async (..._a: unknown[]) => 0),
  createBranch: vi.fn(async () => 'created' as string),
  createClient: vi.fn((_deps: unknown) => ({}) as unknown),
  findFire: vi.fn(async () => null as unknown),
  findPr: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRun: vi.fn(async () => null as unknown),
  findRunInput: vi.fn(async () => null as unknown),
  findUser: vi.fn(async (..._a: unknown[]) => null as { id: string } | null),
  getIssueComment: vi.fn(async () => null as unknown),
  getPullRequestReview: vi.fn(async () => null as unknown),
  listReviewThreads: vi.fn(async () => [] as unknown[]),
  pullRequestInfo: vi.fn(async () => null as unknown),
  repoPermission: vi.fn(async (..._a: unknown[]) => ({ ok: true, permission: 'write' }) as unknown),
  screen: vi.fn(async (_bodies: string[]) => new Set<number>()),
  settings: {} as Record<string, unknown>,
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
vi.mock('@auto-swe/shared/lib/repoMembership', () => ({ isRepoMember: vi.fn(() => true) }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ workflowExecution: { workflowId: 'prfb-wf-1' } }),
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => true) }));
vi.mock('../lib/execUtils.js', () => ({
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
vi.mock('../lib/ciLogGuard.js', async (orig) => ({
  ...(await orig<typeof import('../lib/ciLogGuard.js')>()),
  feedbackInjectionScreen: m.screen,
}));
vi.mock('../lib/qodo/client.js', async (orig) => ({
  ...(await orig<typeof import('../lib/qodo/client.js')>()),
  createQodoFindingsClient: (deps: unknown) => {
    m.createClient(deps);
    return m.client;
  },
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    createBranch: m.createBranch,
    getIssueComment: m.getIssueComment,
    getPullRequestReview: m.getPullRequestReview,
    listReviewThreads: m.listReviewThreads,
    prUrl: async (_repo: unknown, n: number) => `https://ghe.example/acme/api/pull/${n}`,
    pullRequestInfo: m.pullRequestInfo,
    repoPermission: m.repoPermission,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { AgentTracer } from '../lib/agentTracer.js';
import { gatherPrFeedback } from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const HEAD = 'a'.repeat(40);
const HEAD_REF = 'feature/work';
const PR_URL = 'https://ghe.example/acme/api/pull/9';
const SKIPPED = 'pr_feedback.qodo_command_skipped';

function request(over: Record<string, unknown> = {}): RepoWorkRequest {
  return {
    description: 'do not trust me',
    externalTicketId: 'prfb-9-777',
    payload: {
      baseBranch: HEAD_REF,
      connectionId: CONN,
      feedbackEventId: '777',
      feedbackEventKind: 'issue_comment',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'command',
      maxRounds: 5,
      pullRequestNumber: 9,
      ...over,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  } as unknown as RepoWorkRequest;
}

const openPr = {
  headRef: HEAD_REF,
  headRepositoryFullName: 'acme/api',
  headSha: HEAD,
  state: 'open',
};

function finding(over: Partial<QodoFinding> = {}): QodoFinding {
  return {
    actionLevel: 'remediation_recommended',
    attributionStatus: 'pending',
    category: 'Quality',
    description: 'The retry loop never backs off.',
    id: '424242',
    source: 'IssueFinding',
    title: 'Retry without backoff',
    ...over,
  };
}

function ok(
  findings: QodoFinding[],
  over: { commitSha?: string; status?: 'completed' | 'failed' | 'other'; withheld?: number } = {}
): QodoPrReviewState {
  return {
    findingCount: findings.length,
    findings,
    kind: 'ok',
    session: {
      commitSha: over.commitSha ?? HEAD,
      runId: 1,
      startedAt: '2026-10-20T00:00:00Z',
      status: over.status ?? 'completed',
    },
    truncated: false,
    unrecognisedStatuses: 0,
    withheldFields: over.withheld ?? 0,
  };
}

let fake: ReturnType<typeof createFakeQodoFindingsClient>;
const script = (...states: QodoPrReviewState[]) => {
  fake = createFakeQodoFindingsClient(states);
  m.client = fake;
};

const humanThread = (id: string, body: string, databaseId: number) => ({
  comments: [
    {
      authorId: '42',
      authorLogin: 'reviewer',
      authorType: 'User',
      body,
      createdAt: '2026-10-20T00:00:01Z',
      databaseId,
      reviewDatabaseId: 700,
    },
  ],
  isOutdated: false,
  isResolved: false,
  line: 3,
  path: 'src/a.ts',
  threadId: id,
});

let events: Array<{ name: string; outputJson?: unknown }>;
const skipEvents = () => events.filter((e) => e.name === SKIPPED);

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (vi.isMockFunction(f)) {
      f.mockReset();
    }
  }
  m.settings = {
    'qodo.enabled': true,
    'qodo.prFeedbackIncludeOnCommand': true,
    'qodo.prFeedbackMinActionLevel': 'remediation_recommended',
  };
  m.findFire.mockResolvedValue({
    automation: { connectionId: CONN, source: 'github.pull_request.feedback', templateId: null },
    createdAt: new Date('2026-10-20T00:00:00Z'),
    outcome: 'STARTED',
    ownerKey: 'ghe.example/acme/api',
    source: 'github.pull_request.feedback',
    temporalWorkflowId: 'prfb-wf-1',
    workRequestId: 'wr-1',
  });
  m.findRepo.mockResolvedValue({
    id: CONN,
    organizationName: 'acme',
    repoName: 'api',
    team: { orgId: 'org-1' },
    teamId: 'team-1',
  });
  m.pullRequestInfo.mockResolvedValue(openPr);
  m.getIssueComment.mockResolvedValue({
    authorId: '42',
    authorLogin: 'reviewer',
    authorType: 'User',
    body: '/auto-swe fix',
    issueNumber: 9,
  });
  m.findRunInput.mockResolvedValue({
    // On a host other than github.com the linked id carries the host.
    requestedBy: { githubLoginAccountId: 'ghe.example:42', id: 'user-1', isActive: true },
  });
  m.findUser.mockResolvedValue({ id: 'user-1' });
  m.repoPermission.mockResolvedValue({ ok: true, permission: 'write' });
  m.findPr.mockResolvedValue({
    workflow: { currentStatus: 'COMPLETED', temporalWorkflowId: 'wf-original' },
  });
  m.findRun.mockResolvedValue({
    template: { origin: 'WORKFLOW', teamId: 'team-1' },
    workRequest: { description: 'original task', payload: {} },
  });
  m.countFire.mockResolvedValue(0);
  m.createBranch.mockResolvedValue('created');
  m.screen.mockResolvedValue(new Set<number>());
  m.listReviewThreads.mockResolvedValue([humanThread('th-1', 'please rename this', 101)]);
  script(ok([finding({ title: 'Retry without backoff' })]));
  events = [];
  vi.spyOn(AgentTracer.prototype, 'addActivityEvent').mockImplementation((e) => {
    events.push(e);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gatherPrFeedback — Qodo findings in a command round', () => {
  it('appends pending findings at or above the level after the human threads, once, with no wait', async () => {
    script(
      ok([
        finding({ actionLevel: 'informational', title: 'Too minor' }),
        finding({ actionLevel: 'action_required', title: 'Severe one' }),
        finding({ attributionStatus: 'dismissed', title: 'Dismissed one' }),
        finding({ title: 'Middling one' }),
      ])
    );
    m.listReviewThreads.mockResolvedValue([
      humanThread('th-1', 'please rename this', 101),
      humanThread('th-2', 'and this too', 102),
    ]);
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix', origin: 'workflow', round: 1 });
    expect(r.threads.map((t) => t.label)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(r.threads[0]?.threadId).toBe('th-1');
    expect(r.threads[2]).toMatchObject({ path: '', replyToCommentId: 0, threadId: '' });
    expect(r.brief.indexOf('[T2]')).toBeLessThan(r.brief.indexOf('[T3] Qodo finding'));
    expect(r.brief).toContain('[T3] Qodo finding (action_required)\n— Qodo: Severe one');
    expect(r.brief).toContain('[T4] Qodo finding (remediation_recommended)\n— Qodo: Middling one');
    for (const absent of ['Too minor', 'Dismissed one']) {
      expect(r.brief).not.toContain(absent);
    }
    expect(r.brief).toContain('— @reviewer: please rename this');
    // The trigger text stays the human one, and Qodo is read once for the repository's team.
    expect(r.brief).toContain('[TRIGGER] (no additional notes)');
    expect(fake.calls).toEqual([PR_URL]);
    expect(m.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' })
    );
    expect(skipEvents()).toEqual([]);
  });

  it('counts a dropped finding with the human ones', async () => {
    script(ok([finding({ title: 'A' }), finding({ title: 'B' })]));
    // The human thread is screened in its own batch; the Qodo batch refuses finding B.
    m.screen.mockImplementation(async (bodies: string[]) =>
      bodies.some((b) => b.startsWith('B\n')) ? new Set([1]) : new Set<number>()
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r.dropped.screened).toBe(1);
    expect(r.threads).toHaveLength(2);
    expect(r.brief).toContain('— Qodo: A');
    expect(r.brief).not.toContain('— Qodo: B');
  });

  it('drops a finding the result screen withheld', async () => {
    script(
      ok(
        [
          finding({ description: '[withheld: failed the injection screen]', title: 'Hidden' }),
          finding({ title: 'Kept' }),
        ],
        { withheld: 1 }
      )
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r.dropped.screened).toBe(1);
    expect(r.brief).toContain('— Qodo: Kept');
    expect(r.brief).not.toContain('Hidden');
  });

  it('proceeds on Qodo findings alone when there are no human threads and no notes', async () => {
    m.listReviewThreads.mockResolvedValue([]);
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix' });
    expect(r.threads.map((t) => t.label)).toEqual(['T1']);
    expect(r.brief).toContain('[T1] Qodo finding');
  });

  it('still skips with nothing usable at all, and records why Qodo added nothing', async () => {
    m.listReviewThreads.mockResolvedValue([]);
    script(ok([]));
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', reason: 'nothing usable in the feedback' });
    expect(skipEvents()).toHaveLength(1);
  });
});

describe('gatherPrFeedback — a command round Qodo adds nothing to', () => {
  const cases: Array<[string, () => void, string]> = [
    [
      'Qodo cannot be read',
      () => script({ kind: 'unavailable', reason: 'call_failed' }),
      'Qodo could not be read',
    ],
    [
      'Qodo has no review',
      () => script({ kind: 'no_session' }),
      'Qodo has no review of this pull request',
    ],
    [
      'Qodo reviewed another commit',
      () => script(ok([finding()], { commitSha: 'b'.repeat(40) })),
      'Qodo has not reviewed the pull request’s current head commit',
    ],
    [
      'the review is not completed',
      () => script(ok([finding()], { status: 'other' })),
      'Qodo has not finished reviewing the pull request',
    ],
    [
      'the review failed',
      () => script(ok([finding()], { status: 'failed' })),
      'Qodo’s review of this commit failed',
    ],
    [
      'no finding qualifies',
      () => script(ok([finding({ actionLevel: 'informational' })])),
      'Qodo has no open findings at or above the configured level',
    ],
    [
      'every finding is screened out',
      () => {
        script(ok([finding()]));
        m.screen.mockImplementation(async (b: string[]) =>
          b.length === 1 && b[0]?.startsWith('Retry') ? new Set([0]) : new Set<number>()
        );
      },
      'nothing usable in Qodo’s findings',
    ],
  ];
  it.each(cases)(
    'keeps the human threads when %s, with one fixed-reason event',
    async (_name, arrange, reason) => {
      arrange();
      const r = await gatherPrFeedback({ request: request() });
      expect(r).toMatchObject({ decision: 'fix' });
      expect(r.threads.map((t) => t.label)).toEqual(['T1']);
      expect(r.brief).not.toContain('Qodo finding');
      expect(skipEvents()).toEqual([{ name: SKIPPED, outputJson: { reason } }]);
      expect(fake.calls).toHaveLength(1);
    }
  );

  it('keeps the human threads when the head moved between the read and the recheck', async () => {
    m.pullRequestInfo.mockResolvedValueOnce(openPr).mockResolvedValue({
      ...openPr,
      headSha: 'c'.repeat(40),
    });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix', headSha: HEAD });
    expect(r.threads.map((t) => t.label)).toEqual(['T1']);
    expect(r.brief).not.toContain('Qodo finding');
    // The head is read once for the round and once to recheck it after Qodo was read.
    expect(m.pullRequestInfo).toHaveBeenCalledTimes(2);
    expect(skipEvents()).toEqual([
      {
        name: SKIPPED,
        outputJson: { reason: 'the pull request’s head moved while Qodo was read' },
      },
    ]);
  });

  it('keeps the human threads when the host fails while Qodo is read, naming no error', async () => {
    m.pullRequestInfo
      .mockResolvedValueOnce(openPr)
      .mockRejectedValueOnce(new Error('GitHub 502: upstream-secret-detail'));
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix' });
    expect(r.threads.map((t) => t.label)).toEqual(['T1']);
    expect(r.brief).not.toContain('Qodo finding');
    expect(skipEvents()).toEqual([
      { name: SKIPPED, outputJson: { reason: 'Qodo could not be read' } },
    ]);
    expect(JSON.stringify(events)).not.toContain('upstream-secret-detail');
  });

  it('numbers the findings after the human threads that were kept, not the ones dropped', async () => {
    const stranger = humanThread('th-x', 'from a stranger', 103);
    stranger.comments[0] = { ...stranger.comments[0], authorId: '99', authorLogin: 'stranger' };
    m.findUser.mockImplementation(async (q: unknown) => {
      const ids = (q as { where: { githubLoginAccountId: { in: string[] } } }).where
        .githubLoginAccountId.in;
      return ids.some((id) => id.endsWith(':42')) ? { id: 'user-1' } : null;
    });
    m.listReviewThreads.mockResolvedValue([
      stranger,
      humanThread('th-1', 'please rename this', 101),
      humanThread('th-2', 'and this too', 102),
    ]);
    const r = await gatherPrFeedback({ request: request() });
    expect(r.threads.map((t) => t.label)).toEqual(['T1', 'T2', 'T3']);
    expect(r.threads.map((t) => t.threadId)).toEqual(['th-1', 'th-2', '']);
    expect(r.brief).toContain('[T3] Qodo finding');
    expect(r.brief).not.toContain('from a stranger');
  });

  it('asks Qodo nothing when the human threads already fill the brief', async () => {
    m.listReviewThreads.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => humanThread(`th-${i}`, `fix number ${i}`, 1000 + i))
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(100);
    expect(fake.calls).toHaveLength(0);
    expect(skipEvents()).toEqual([
      { name: SKIPPED, outputJson: { reason: 'the brief is already full' } },
    ]);
  });

  it('adds only as many findings as the human threads leave room for', async () => {
    m.listReviewThreads.mockResolvedValue(
      Array.from({ length: 97 }, (_, i) => humanThread(`th-${i}`, `fix number ${i}`, 1000 + i))
    );
    script(
      ok(Array.from({ length: 10 }, (_, i) => finding({ id: `${i}`, title: `Finding ${i}` })))
    );
    const r = await gatherPrFeedback({ request: request() });
    // The brief never holds more than the 100 threads a round allows, human and Qodo together.
    expect(r.threads).toHaveLength(100);
    expect(r.threads.slice(97).map((t) => t.label)).toEqual(['T98', 'T99', 'T100']);
    expect(r.brief).toContain('[T100] Qodo finding');
    expect(r.brief).not.toContain('[T101]');
  });

  it('shares one character budget between the human threads and the findings', async () => {
    const long = 'x'.repeat(1000);
    m.listReviewThreads.mockResolvedValue(
      Array.from({ length: 45 }, (_, i) => humanThread(`th-${i}`, `${long} ${i}`, 1000 + i))
    );
    m.settings['qodo.prFeedbackIncludeOnCommand'] = false;
    const without = await gatherPrFeedback({ request: request() });
    m.settings['qodo.prFeedbackIncludeOnCommand'] = true;
    events = [];
    const withQodo = await gatherPrFeedback({ request: request() });
    // The human threads alone already spent the budget, so the one finding is over the limit.
    expect(withQodo.brief).not.toContain('Qodo finding');
    expect(withQodo.dropped.overLimit).toBe(without.dropped.overLimit + 1);
    expect(withQodo.threads).toHaveLength(without.threads.length);
    expect(skipEvents()).toEqual([
      { name: SKIPPED, outputJson: { reason: 'nothing usable in Qodo’s findings' } },
    ]);
  });

  it('records no team as an event and makes no call', async () => {
    m.findRepo.mockResolvedValue({
      id: CONN,
      organizationName: 'acme',
      repoName: 'api',
      team: null,
      teamId: null,
    });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix' });
    expect(fake.calls).toHaveLength(0);
    expect(skipEvents()).toEqual([
      { name: SKIPPED, outputJson: { reason: 'the repository has no team to read Qodo for' } },
    ]);
  });
});

describe('gatherPrFeedback — when a command round never asks Qodo', () => {
  it('makes no Qodo call and records no event with the setting off (the default)', async () => {
    m.settings['qodo.prFeedbackIncludeOnCommand'] = false;
    const r = await gatherPrFeedback({ request: request() });
    expect(r.threads.map((t) => t.label)).toEqual(['T1']);
    expect(fake.calls).toHaveLength(0);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(skipEvents()).toEqual([]);
  });

  it('makes no Qodo call and records no event with Qodo disabled', async () => {
    m.settings['qodo.enabled'] = false;
    await gatherPrFeedback({ request: request() });
    expect(fake.calls).toHaveLength(0);
    expect(skipEvents()).toEqual([]);
  });

  it('makes no Qodo call on a pull request the platform did not open', async () => {
    m.findPr.mockResolvedValue(null);
    m.settings['github.prFeedbackOtherPullRequestsEnabled'] = true;
    const r = await gatherPrFeedback({ request: request({ feedbackOrigin: 'other' }) });
    expect(r).toMatchObject({ decision: 'fix', origin: 'other' });
    expect(fake.calls).toHaveLength(0);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(skipEvents()).toEqual([]);
  });

  it('never reads Qodo for a changes_requested round, even with both settings on', async () => {
    m.getPullRequestReview.mockResolvedValue({
      authorId: '42',
      authorLogin: 'reviewer',
      authorType: 'User',
      body: 'please fix',
      state: 'changes_requested',
    });
    const r = await gatherPrFeedback({
      request: request({ feedbackEventKind: 'review', feedbackTrigger: 'changes_requested' }),
    });
    expect(r).toMatchObject({ decision: 'fix' });
    expect(fake.calls).toHaveLength(0);
    expect(skipEvents()).toEqual([]);
  });
});
