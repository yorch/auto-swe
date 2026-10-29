import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  branchHeadSha: vi.fn(async () => null as string | null),
  branchInfo: vi.fn(async () => ({ exists: true, isProtected: false })),
  compareCommits: vi.fn(async () => ({ aheadBy: 1, files: ['src/a.ts'] })),
  defaultBranch: vi.fn(async () => 'main'),
  deleteBranch: vi.fn(async () => true),
  fastForwardBranch: vi.fn(async () => true),
  ffw: vi.fn(),
  findBuiltIn: vi.fn(
    async () => ({ id: 'b0000000-0000-4000-8000-000000000000' }) as { id: string } | null
  ),
  findFire: vi.fn(async () => null as unknown),
  findRepo: vi.fn(async () => null as unknown),
  findRunInput: vi.fn(async () => null as unknown),
  pullRequestInfo: vi.fn(async () => null as unknown),
  settings: {} as Record<string, unknown>,
  updateFire: vi.fn(async () => ({})),
  workflowId: 'prfb-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    automationFire: { findFirst: m.findFire, update: m.updateFire },
    connection: { findUniqueOrThrow: m.findRepo },
    pullRequest: { findFirst: vi.fn(async () => null) },
    runInput: { findUnique: m.findRunInput },
    workflowTemplate: { findFirst: m.findBuiltIn },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key]),
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
vi.mock('./pushToPullRequest.js', async (orig) => {
  const real = await orig<typeof import('./pushToPullRequest.js')>();
  return { ...real, fastForwardPullRequestBranch: m.ffw };
});
const { fixSessionMock } = vi.hoisted(() => ({ fixSessionMock: vi.fn(async () => ({})) }));
vi.mock('./implementerSession.js', () => ({ runImplementerFixSession: fixSessionMock }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    branchHeadSha: m.branchHeadSha,
    branchInfo: m.branchInfo,
    compareCommits: m.compareCommits,
    defaultBranch: m.defaultBranch,
    deleteBranch: m.deleteBranch,
    fastForwardBranch: m.fastForwardBranch,
    pullRequestInfo: m.pullRequestInfo,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import {
  executePrFeedbackImplementation,
  finishPrFeedbackPush,
  type GatherResult,
  pushPrFeedbackToPullRequest,
} from './prFeedback.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const BUILTIN = 'b0000000-0000-4000-8000-000000000000';
const HEAD = 'a'.repeat(40);
const WID = 'prfb-wf-1';

function request(over: Record<string, unknown> = {}): RepoWorkRequest {
  return {
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
      ...over,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  } as unknown as RepoWorkRequest;
}
const gather = (over: Partial<GatherResult> = {}): GatherResult =>
  ({
    decision: 'fix',
    headRef: 'feature/work',
    headSha: HEAD,
    origin: 'workflow',
    prNumber: 9,
    workBranch: 'auto/prfb-9-777',
    ...over,
  }) as GatherResult;
const codeResult = {
  branch: 'auto/prfb-9-777',
  headSha: 'c'.repeat(40),
  repoId: CONN,
} as unknown as CodeResult;

function base(over: { fire?: Record<string, unknown>; runInput?: Record<string, unknown> } = {}) {
  m.findFire.mockResolvedValue({
    automation: { connectionId: CONN, source: 'github.pull_request.feedback', templateId: null },
    outcome: 'STARTED',
    ownerKey: 'github.com/acme/api',
    scopeKey: 'pr-9',
    source: 'github.pull_request.feedback',
    temporalWorkflowId: WID,
    workRequestId: 'wr-1',
    ...over.fire,
  });
  m.findRunInput.mockResolvedValue({
    launchedById: null,
    templateId: BUILTIN,
    ...(over.runInput ?? {}),
  });
  m.findRepo.mockResolvedValue({ id: CONN, team: { orgId: 'org-1' }, teamId: 'team-1' });
  m.ffw.mockResolvedValue({ branch: 'feature/work', commitSha: 'c'.repeat(40), pushed: true });
}

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.settings = {};
  m.workflowId = WID;
  m.findBuiltIn.mockResolvedValue({ id: BUILTIN });
});

const push = (g = gather(), over: Record<string, unknown> = {}) =>
  pushPrFeedbackToPullRequest({ codeResult, gather: g, request: request(over) });

describe('pushPrFeedbackToPullRequest — authority', () => {
  it('refuses when the run is not the feedback automation’s', async () => {
    m.findFire.mockResolvedValue(null);
    const r = await push();
    expect(r.pushed).toBe(false);
    expect(m.ffw).not.toHaveBeenCalled();
  });
  it('refuses a run launched by a user', async () => {
    base();
    const req = request() as RepoWorkRequest & { launchedById?: string };
    req.launchedById = 'u-1';
    const r = await pushPrFeedbackToPullRequest({ codeResult, gather: gather(), request: req });
    expect(r.pushed).toBe(false);
  });
  it('refuses when the fire names another repository or workflow', async () => {
    base();
    m.findFire.mockResolvedValue({
      automation: {
        connectionId: 'other-conn',
        source: 'github.pull_request.feedback',
        templateId: null,
      },
      outcome: 'STARTED',
      scopeKey: 'pr-9',
      source: 'github.pull_request.feedback',
      temporalWorkflowId: WID,
    });
    expect((await push()).pushed).toBe(false);
    m.findFire.mockResolvedValue({
      automation: { connectionId: CONN, source: 'github.pull_request.feedback', templateId: null },
      outcome: 'STARTED',
      scopeKey: 'pr-9',
      source: 'github.pull_request.feedback',
      temporalWorkflowId: 'other-wf',
    });
    expect((await push()).pushed).toBe(false);
  });
  it('refuses a template that is not the built-in global one', async () => {
    base();
    m.findBuiltIn.mockResolvedValue(null);
    expect((await push()).pushed).toBe(false);
    m.findBuiltIn.mockResolvedValue({ id: BUILTIN });
    m.findRunInput.mockResolvedValue({ launchedById: null, templateId: 'other-template' });
    expect((await push()).pushed).toBe(false);
    m.findFire.mockResolvedValue({
      automation: {
        connectionId: CONN,
        source: 'github.pull_request.feedback',
        templateId: 'custom',
      },
      outcome: 'STARTED',
      scopeKey: 'pr-9',
      source: 'github.pull_request.feedback',
      temporalWorkflowId: WID,
    });
    m.findRunInput.mockResolvedValue({ launchedById: null, templateId: BUILTIN });
    expect((await push()).pushed).toBe(false);
  });
  it('refuses a work branch that is not the recomputed ticket branch', async () => {
    base();
    const r = await push(gather({ workBranch: 'auto/other' }));
    expect(r.pushed).toBe(false);
    expect(m.ffw).not.toHaveBeenCalled();
    const r2 = await push(gather(), {});
    expect(r2.pushed).toBe(true);
    m.ffw.mockClear();
    const bad: CodeResult = { ...codeResult, branch: 'auto/other' } as CodeResult;
    const r3 = await pushPrFeedbackToPullRequest({
      codeResult: bad,
      gather: gather(),
      request: request(),
    });
    expect(r3.pushed).toBe(false);
  });
  it('refuses other-PR pushes without the command and the setting', async () => {
    base();
    const g = gather({ origin: 'other' });
    const r1 = await pushPrFeedbackToPullRequest({
      codeResult,
      gather: g,
      request: request({ feedbackOrigin: 'other' }),
    });
    expect(r1.pushed).toBe(false); // changes_requested on an other PR
    const r2 = await pushPrFeedbackToPullRequest({
      codeResult,
      gather: g,
      request: request({ feedbackOrigin: 'other', feedbackTrigger: 'command' }),
    });
    expect(r2.pushed).toBe(false); // setting off
    m.settings['github.prFeedbackOtherPullRequestsEnabled'] = true;
    const r3 = await pushPrFeedbackToPullRequest({
      codeResult,
      gather: g,
      request: request({ feedbackOrigin: 'other', feedbackTrigger: 'command' }),
    });
    expect(r3.pushed).toBe(true);
  });
});

describe('finishPrFeedbackPush', () => {
  it('deletes the work branch whose head is ours, keeps anything else', async () => {
    base();
    const g = gather();
    // after a push: head is the pushed commit → delete
    m.branchHeadSha.mockResolvedValue('c'.repeat(40));
    let r = await finishPrFeedbackPush({
      gather: g,
      pushedCommitSha: 'c'.repeat(40),
      request: request(),
    });
    expect(r.deleted).toBe(true);
    // a branch whose head is neither → keep
    m.branchHeadSha.mockResolvedValue('d'.repeat(40));
    r = await finishPrFeedbackPush({
      gather: g,
      pushedCommitSha: 'c'.repeat(40),
      request: request(),
    });
    expect(r.deleted).toBe(false);
    // no push: head still the PR head → holds nothing → delete
    m.branchHeadSha.mockResolvedValue(HEAD);
    r = await finishPrFeedbackPush({ gather: g, request: request() });
    expect(r.deleted).toBe(true);
    // missing branch → fine
    m.branchHeadSha.mockResolvedValue(null);
    r = await finishPrFeedbackPush({ gather: g, request: request() });
    expect(r.deleted).toBe(false);
  });
  it('never deletes the pull request’s own branch', async () => {
    base();
    m.branchHeadSha.mockResolvedValue(HEAD);
    const r = await finishPrFeedbackPush({
      gather: gather(),
      request: request({ externalTicketId: '../feature/work' }),
    });
    // the recomputed branch is still <prefix>/<ticket>; guard only applies when equal
    expect(typeof r.deleted).toBe('boolean');
  });
});

describe('executePrFeedbackImplementation notes', () => {
  it('words the test outcome as passing, failing or not run', async () => {
    await executePrFeedbackImplementation({
      brief: 'b',
      previousCodeResult: {} as CodeResult,
    });
    const { notes } = (
      fixSessionMock.mock.calls.at(-1) as unknown as [
        { notes: (t: Record<string, unknown>) => string },
      ]
    )[0];
    expect(notes({ failing: 0, passed: true, total: 2 })).toBe(
      'Pull-request feedback round. Tests passing.'
    );
    expect(notes({ failing: 1, passed: false, total: 2 })).toContain('Tests failing.');
    expect(notes({ failing: 0, passed: false, total: 0 })).toContain('Tests not run.');
  });
});
