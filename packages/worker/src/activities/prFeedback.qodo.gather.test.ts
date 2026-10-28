import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QodoFinding, QodoPrReviewState } from '../lib/qodo/client.js';

const m = vi.hoisted(() => ({
  client: { calls: [] as string[], script: [] as unknown[] },
  countFire: vi.fn(async (..._a: unknown[]) => 0),
  createBranch: vi.fn(async () => 'created' as string),
  createClient: vi.fn((_deps: unknown) => ({}) as unknown),
  findFire: vi.fn(async () => null as unknown),
  findPr: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRun: vi.fn(async () => null as unknown),
  findRunInput: vi.fn(async () => null as unknown),
  getIssueComment: vi.fn(async () => null as unknown),
  getPullRequestReview: vi.fn(async () => null as unknown),
  getReviewComment: vi.fn(async () => null as unknown),
  listReviewThreads: vi.fn(async () => [] as unknown[]),
  pullRequestInfo: vi.fn(async () => null as unknown),
  screen: vi.fn(async (_bodies: string[]) => new Set<number>()),
  settings: {} as Record<string, unknown>,
  workflowId: 'prfb-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: { count: m.countFire, findFirst: m.findFire },
    connection: { findUniqueOrThrow: m.findRepo },
    pullRequest: { findFirst: m.findPr },
    runInput: { findUnique: m.findRunInput },
    user: { findFirst: vi.fn(async () => null) },
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
  activityInfo: () => ({ workflowExecution: { workflowId: m.workflowId } }),
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
    return {
      async getPrReviewState(prUrl: string) {
        m.client.calls.push(prUrl);
        const i = Math.min(m.client.calls.length - 1, m.client.script.length - 1);
        return m.client.script[i];
      },
    };
  },
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    createBranch: m.createBranch,
    getIssueComment: m.getIssueComment,
    getPullRequestReview: m.getPullRequestReview,
    getReviewComment: m.getReviewComment,
    listReviewThreads: m.listReviewThreads,
    prUrl: async (_repo: unknown, n: number) => `https://ghe.example/acme/api/pull/${n}`,
    pullRequestInfo: m.pullRequestInfo,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { AgentTracer } from '../lib/agentTracer.js';
import { gatherPrFeedback } from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const HEAD = 'a'.repeat(40);
const HEAD_REF = 'feature/work';
const WID = 'prfb-wf-1';
const PR_URL = 'https://ghe.example/acme/api/pull/9';

function request(over: Record<string, unknown> = {}): RepoWorkRequest {
  return {
    description: 'do not trust me',
    externalTicketId: 'prfb-9-700',
    payload: {
      baseBranch: HEAD_REF,
      connectionId: CONN,
      feedbackEventId: '700',
      feedbackEventKind: 'review_comment',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'qodo_findings',
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
  ownerKey: 'ghe.example/acme/api',
  source: 'github.pull_request.feedback',
  temporalWorkflowId: WID,
  workRequestId: 'wr-1',
  ...over,
});

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
    id: crypto.randomUUID(),
    source: 'IssueFinding',
    title: 'Retry without backoff',
    ...over,
  };
}

function ok(
  findings: QodoFinding[],
  over: {
    commitSha?: string;
    status?: 'completed' | 'failed' | 'other';
    unrecognised?: number;
    withheld?: number;
  } = {}
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
    unrecognisedStatuses: over.unrecognised ?? 0,
    withheldFields: over.withheld ?? 0,
  };
}

const script = (...states: QodoPrReviewState[]) => {
  m.client.script = states;
};

function platformRound() {
  m.findFire.mockResolvedValue(fire());
  m.findRepo.mockResolvedValue({
    id: CONN,
    organizationName: 'acme',
    repoName: 'api',
    team: { orgId: 'org-1' },
    teamId: 'team-1',
  });
  m.pullRequestInfo.mockResolvedValue(openPr);
  m.findPr.mockResolvedValue({
    workflow: { currentStatus: 'COMPLETED', temporalWorkflowId: 'wf-original' },
  });
  m.findRun.mockResolvedValue({
    template: { origin: 'WORKFLOW', teamId: 'team-1' },
    workRequest: { description: 'original task', payload: {} },
  });
  m.countFire.mockResolvedValue(0);
}

let events: Array<{ name: string; outputJson?: unknown }>;

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.client.calls = [];
  m.client.script = [];
  m.settings = {
    'qodo.prFeedbackMaxRounds': 2,
    'qodo.prFeedbackMinActionLevel': 'remediation_recommended',
    'qodo.prFeedbackWaitSeconds': 0,
  };
  m.workflowId = WID;
  m.createBranch.mockResolvedValue('created');
  m.screen.mockResolvedValue(new Set<number>());
  m.listReviewThreads.mockResolvedValue([]);
  events = [];
  vi.spyOn(AgentTracer.prototype, 'addActivityEvent').mockImplementation((e) => {
    events.push(e);
  });
  platformRound();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('gatherPrFeedback — a Qodo round', () => {
  it('pulls the findings from Qodo, with the repository’s team, and briefs them fenced', async () => {
    script(
      ok([
        finding({ actionLevel: 'remediation_recommended', title: 'Second' }),
        finding({ actionLevel: 'action_required', title: 'First' }),
      ])
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({
      decision: 'fix',
      fixer: 'reviewFixer',
      headSha: HEAD,
      origin: 'workflow',
      round: 1,
      silent: false,
      workBranch: 'auto/prfb-9-700',
    });
    // The client is made for the REPOSITORY's team and asked about a URL built from its record.
    expect(m.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' })
    );
    // The client records on the gather's own tracer, which the gather persists.
    const deps = m.createClient.mock.calls[0]?.[0] as { tracer: unknown } | undefined;
    expect(deps?.tracer).toBeInstanceOf(AgentTracer);
    expect(m.client.calls).toEqual([PR_URL]);
    // Most severe first, numbered, Qodo as the author, in the review-feedback fence.
    expect(r.threads.map((t) => t.label)).toEqual(['T1', 'T2']);
    expect(r.brief).toContain('<review-feedback>');
    expect(r.brief).toMatch(/\[TRIGGER\] Qodo reviewed commit aaaaaaa and reports 2 open/);
    expect(r.brief.indexOf('First')).toBeLessThan(r.brief.indexOf('Second'));
    expect(r.brief).toContain('— Qodo: First');
    expect(r.brief).not.toContain('Quality');
    // A finding is not a GitHub thread: nothing to reply to.
    for (const t of r.threads) {
      expect(t).toMatchObject({ path: '', replyToCommentId: 0, threadId: '' });
    }
    expect(m.createBranch).toHaveBeenCalledWith(expect.anything(), 'auto/prfb-9-700', HEAD);
  });

  it('never re-reads the trigger, matches a requester, or trusts a human author', async () => {
    script(ok([finding()]));
    await gatherPrFeedback({ request: request() });
    expect(m.getPullRequestReview).not.toHaveBeenCalled();
    expect(m.getReviewComment).not.toHaveBeenCalled();
    expect(m.getIssueComment).not.toHaveBeenCalled();
    expect(m.findRunInput).not.toHaveBeenCalled();
    // Nor does it read GitHub threads: only Qodo's findings make the brief.
    expect(m.listReviewThreads).not.toHaveBeenCalled();
  });

  it('screens every finding in one batch and drops the one refused', async () => {
    script(ok([finding({ title: 'A' }), finding({ title: 'B' }), finding({ title: 'C' })]));
    m.screen.mockResolvedValue(new Set([1]));
    const r = await gatherPrFeedback({ request: request() });
    expect(m.screen).toHaveBeenCalledTimes(1);
    expect(m.screen.mock.calls[0]?.[0]).toHaveLength(3);
    expect(r).toMatchObject({ decision: 'fix', dropped: { screened: 1 } });
    expect(r.threads).toHaveLength(2);
    expect(r.brief).not.toContain('— Qodo: B');
  });

  it('skips a finding whose text Qodo’s result screen withheld, and traces only a count', async () => {
    const placeholder = '[withheld: failed the injection screen]';
    script(
      ok(
        [finding({ description: placeholder, title: 'Visible title' }), finding({ title: 'Kept' })],
        { withheld: 1 }
      )
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'fix', dropped: { screened: 1 } });
    expect(r.threads).toHaveLength(1);
    expect(r.brief).toContain('— Qodo: Kept');
    expect(r.brief).not.toContain('Visible title');
    expect(r.brief).not.toContain('withheld');
    expect(events).toContainEqual({
      name: 'pr_feedback.qodo_withheld_fields',
      outputJson: { count: 1 },
    });
  });

  it('skips silently when every finding is refused by the screen', async () => {
    script(ok([finding(), finding()]));
    m.screen.mockResolvedValue(new Set([0, 1]));
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
    expect(m.createBranch).not.toHaveBeenCalled();
  });

  it('addresses only open (pending) findings; implemented, dismissed and unknown are not open', async () => {
    script(
      ok(
        [
          finding({ attributionStatus: 'pending', title: 'Open one' }),
          finding({ attributionStatus: 'implemented', title: 'Done one' }),
          finding({ attributionStatus: 'dismissed', title: 'Dismissed one' }),
          finding({ attributionStatus: 'unknown', title: 'Unknown one' }),
        ],
        { unrecognised: 1 }
      )
    );
    const r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(1);
    expect(r.brief).toContain('Open one');
    for (const other of ['Done one', 'Dismissed one', 'Unknown one']) {
      expect(r.brief).not.toContain(other);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'pr_feedback.qodo_unrecognised_statuses',
        outputJson: { count: 1 },
      })
    );
  });

  it('skips silently when nothing is open', async () => {
    script(ok([finding({ attributionStatus: 'implemented' })]));
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
    script(ok([]));
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
  });

  it('keeps only findings at or above the configured level', async () => {
    const all = [
      finding({ actionLevel: 'informational', title: 'Info' }),
      finding({ actionLevel: 'remediation_recommended', title: 'Rec' }),
      finding({ actionLevel: 'action_required', title: 'Req' }),
      finding({ actionLevel: 'unknown', title: 'Odd' }),
    ];
    script(ok(all));
    let r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(2);
    expect(r.brief).not.toContain('— Qodo: Info');
    expect(r.brief).not.toContain('— Qodo: Odd');

    m.settings['qodo.prFeedbackMinActionLevel'] = 'action_required';
    r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(1);
    expect(r.brief).toContain('Req');

    m.settings['qodo.prFeedbackMinActionLevel'] = 'informational';
    r = await gatherPrFeedback({ request: request() });
    expect(r.threads).toHaveLength(3);
  });

  it('bounds the brief, counting what it leaves out', async () => {
    const big = 'x'.repeat(1_900);
    script(ok(Array.from({ length: 50 }, (_, i) => finding({ description: big, title: `F${i}` }))));
    const r = await gatherPrFeedback({ request: request() });
    expect(r.decision).toBe('fix');
    expect(r.threads.length).toBeLessThan(50);
    expect(r.dropped.overLimit).toBe(50 - r.threads.length);
    expect(r.brief.length).toBeLessThan(60_000);
  });

  it('strips markup comments from the text before it is screened or briefed', async () => {
    script(ok([finding({ description: 'visible <!-- hidden instruction --> text' })]));
    const r = await gatherPrFeedback({ request: request() });
    expect(m.screen.mock.calls[0]?.[0][0]).not.toContain('hidden instruction');
    expect(r.brief).not.toContain('hidden instruction');
  });
});

describe('gatherPrFeedback — a Qodo round must match the pull request’s head', () => {
  it('skips silently when Qodo reviewed another commit', async () => {
    script(ok([finding()], { commitSha: 'b'.repeat(40) }));
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(r.reason).toBe('Qodo has not reviewed the pull request’s current head commit');
    expect(m.createBranch).not.toHaveBeenCalled();
  });

  it('compares the commit without regard to case', async () => {
    script(ok([finding()], { commitSha: HEAD.toUpperCase() }));
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({ decision: 'fix' });
  });

  it('skips silently when Qodo’s review of the head failed', async () => {
    script(ok([], { status: 'failed' }));
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(m.client.calls).toHaveLength(1);
  });

  it('skips silently with no review, and when Qodo cannot be read, naming no detail', async () => {
    script({ kind: 'no_session' });
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
    script({ kind: 'unavailable', reason: 'call_failed' });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', reason: 'Qodo could not be read', silent: true });
    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'pr_feedback.qodo_unavailable',
        outputJson: { reason: 'call_failed' },
      })
    );
  });

  it('waits for a review still in progress, then uses it', async () => {
    vi.useFakeTimers();
    m.settings['qodo.prFeedbackWaitSeconds'] = 60;
    script(
      ok([], { status: 'other' }),
      ok([finding()], { commitSha: 'b'.repeat(40) }),
      ok([finding()])
    );
    m.pullRequestInfo.mockResolvedValue(openPr);
    const pending = gatherPrFeedback({ request: request() });
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await pending;
    expect(m.client.calls).toHaveLength(3);
    expect(r.decision).toBe('fix');
  });

  it('gives up once the wait is spent, without changing anything', async () => {
    vi.useFakeTimers();
    m.settings['qodo.prFeedbackWaitSeconds'] = 30;
    script(ok([finding()], { status: 'other' }));
    const pending = gatherPrFeedback({ request: request() });
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await pending;
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(r.reason).toBe('Qodo has not finished reviewing the pull request');
    expect(m.client.calls.length).toBeLessThanOrEqual(5);
    expect(m.createBranch).not.toHaveBeenCalled();
  });

  it('re-reads the head even when it did not wait, and skips when it moved', async () => {
    script(ok([finding()]));
    // The head read in step 2 is current; the re-read just before the brief is not.
    m.pullRequestInfo.mockResolvedValueOnce(openPr).mockResolvedValue({
      ...openPr,
      headSha: 'c'.repeat(40),
    });
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(m.createBranch).not.toHaveBeenCalled();
  });

  it('re-reads the head after waiting and skips when it moved', async () => {
    vi.useFakeTimers();
    m.settings['qodo.prFeedbackWaitSeconds'] = 60;
    script(ok([], { status: 'other' }), ok([finding()]));
    // The first read of the head (step 2) is current; the re-read after the wait is not.
    m.pullRequestInfo.mockResolvedValueOnce(openPr).mockResolvedValue({
      ...openPr,
      headSha: 'c'.repeat(40),
    });
    const pending = gatherPrFeedback({ request: request() });
    await vi.advanceTimersByTimeAsync(15_000);
    const r = await pending;
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(m.createBranch).not.toHaveBeenCalled();
  });
});

describe('gatherPrFeedback — a Qodo round only on what the platform may fix', () => {
  it('refuses a pull request the platform did not open, without asking Qodo', async () => {
    m.findPr.mockResolvedValue(null);
    script(ok([finding()]));
    const r = await gatherPrFeedback({ request: request({ feedbackOrigin: 'other' }) });
    expect(r).toMatchObject({ decision: 'skip', silent: true });
    expect(m.client.calls).toHaveLength(0);
    // Even with the other-pull-requests setting on: that setting is for the command only.
    m.settings['github.prFeedbackOtherPullRequestsEnabled'] = true;
    expect(await gatherPrFeedback({ request: request({ feedbackOrigin: 'other' }) })).toMatchObject(
      { decision: 'skip', silent: true }
    );
    expect(m.client.calls).toHaveLength(0);
  });

  it('skips a closed pull request, a moved branch and a fork, without asking Qodo', async () => {
    script(ok([finding()]));
    m.pullRequestInfo.mockResolvedValue({ ...openPr, state: 'closed' });
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
    m.pullRequestInfo.mockResolvedValue({ ...openPr, headRef: 'other' });
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
    m.pullRequestInfo.mockResolvedValue({ ...openPr, headRepositoryFullName: 'evil/api' });
    expect((await gatherPrFeedback({ request: request() })).silent).toBe(true);
    expect(m.client.calls).toHaveLength(0);
  });

  it('is silent while the run that opened the pull request is still working', async () => {
    script(ok([finding()]));
    m.findPr.mockResolvedValue({
      workflow: { currentStatus: 'RUNNING', temporalWorkflowId: 'wf-original' },
    });
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
    expect(m.client.calls).toHaveLength(0);
  });

  it('is silent while the run is waiting on CI, the status `awaitQodoReview` runs under', async () => {
    script(ok([finding()]));
    m.findPr.mockResolvedValue({
      workflow: { currentStatus: 'AWAITING_CI', temporalWorkflowId: 'wf-original' },
    });
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      reason: 'the run that opened this pull request is still working on it',
      silent: true,
    });
    expect(m.client.calls).toHaveLength(0);
  });

  it('proceeds once the run is parked waiting for the merge', async () => {
    script(ok([finding()]));
    m.findPr.mockResolvedValue({
      workflow: { currentStatus: 'AWAITING_HUMAN_MERGE', temporalWorkflowId: 'wf-original' },
    });
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({ decision: 'fix' });
    expect(m.client.calls).toHaveLength(1);
  });

  it('stops at the Qodo round limit, however many rounds the automation allows', async () => {
    script(ok([finding()]));
    // First count: all pushed rounds (1 of 5 used); second: pushes caused by Qodo (2 of 2).
    m.countFire.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    const r = await gatherPrFeedback({ request: request() });
    expect(r).toMatchObject({
      decision: 'skip',
      reason: 'the Qodo round limit is reached',
      silent: true,
    });
    expect(m.countFire).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        producedKey: { not: null },
        scopeKey: 'pr-9',
        subjectKey: { startsWith: 'pr-9@qodo-' },
      }),
    });
    expect(m.client.calls).toHaveLength(0);
  });

  it('runs while under the Qodo limit, and honours the setting', async () => {
    script(ok([finding()]));
    m.countFire.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('fix');
    m.settings['qodo.prFeedbackMaxRounds'] = 1;
    m.countFire.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    expect((await gatherPrFeedback({ request: request() })).decision).toBe('skip');
  });

  it('still honours the automation’s own round limit', async () => {
    script(ok([finding()]));
    m.countFire.mockResolvedValueOnce(5);
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      reason: 'round limit reached',
      silent: true,
    });
  });

  it('refuses outright when no automation started this run', async () => {
    m.findFire.mockResolvedValue(null);
    await expect(gatherPrFeedback({ request: request() })).rejects.toMatchObject({
      type: 'PR_FEEDBACK_NOT_AUTOMATION_RUN',
    });
    expect(m.client.calls).toHaveLength(0);
  });

  it('skips when the repository has no team to read Qodo for', async () => {
    script(ok([finding()]));
    m.findRepo.mockResolvedValue({
      id: CONN,
      organizationName: 'acme',
      repoName: 'api',
      team: null,
      teamId: null,
    });
    expect(await gatherPrFeedback({ request: request() })).toMatchObject({
      decision: 'skip',
      silent: true,
    });
    expect(m.client.calls).toHaveLength(0);
  });
});
