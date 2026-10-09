import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  branchHeadSha: vi.fn(),
  branchInfo: vi.fn(),
  compareCommits: vi.fn(),
  defaultBranch: vi.fn(),
  deleteBranch: vi.fn(),
  fastForwardBranch: vi.fn(),
  findBuiltIn: vi.fn(),
  findFire: vi.fn(),
  findRepo: vi.fn(),
  findRunInput: vi.fn(),
  order: [] as string[],
  pullRequestInfo: vi.fn(),
  settings: {} as Record<string, unknown>,
  updateFire: vi.fn(),
  workflowId: 'ci-wf-1' as string | undefined,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    ciFailureTriggerFire: { findFirst: m.findFire, update: m.updateFire },
    connection: { findUniqueOrThrow: m.findRepo },
    runInput: { findUnique: m.findRunInput },
    workflowTemplate: { findFirst: m.findBuiltIn },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key]),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => {
    if (m.workflowId === undefined) {
      throw new Error('Activity context is not available');
    }
    return { workflowExecution: { workflowId: m.workflowId } };
  },
  heartbeat: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => true) }));
vi.mock('../lib/execUtils.js', () => ({
  throwIfActivityCancelled: () => undefined,
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
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

import { type CiTriageResult, pushCiFixToPullRequest } from './ciTriage.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const TIP = 'b'.repeat(40);
const FIX = 'c'.repeat(40);
const BUILTIN = 'b0000000-0000-4000-8000-000000000000';
const BRANCH = 'feature/sum';

function request(payload: Record<string, unknown> = {}): RepoWorkRequest {
  return {
    description: 'Fix CI',
    externalTicketId: 'ci-1-1',
    payload: {
      baseBranch: BRANCH,
      connectionId: CONN,
      githubRunId: '1',
      mode: 'fix',
      pullRequestDelivery: 'push',
      pullRequestNumber: 7,
      runAttempt: 1,
      ...payload,
    },
    repoId: CONN,
    workRequestId: 'wr-1',
  } as unknown as RepoWorkRequest;
}

const triage = (over: Partial<CiTriageResult> = {}): CiTriageResult =>
  ({
    decision: 'fix',
    pullRequestNumber: 7,
    run: { event: 'pull_request', headBranch: BRANCH },
    ...over,
  }) as CiTriageResult;

const codeResult = { branch: 'auto/ci-1-1', headSha: FIX, repoId: CONN } as CodeResult;

const push = (over: { request?: RepoWorkRequest; triage?: CiTriageResult } = {}) =>
  pushCiFixToPullRequest({
    codeResult,
    request: over.request ?? request(),
    triage: over.triage ?? triage(),
  });

const fireRow = (over: Record<string, unknown> = {}) => ({
  fixCommitSha: null,
  headBranch: BRANCH,
  id: 'fire-1',
  temporalWorkflowId: 'ci-wf-1',
  trigger: { connectionId: CONN, inputs: { pullRequestDelivery: 'push' }, templateId: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.order = [];
  m.settings = {
    'github.ciFixNeverPushBranches': ['main', 'release/**'],
    'github.ciFixPushToPullRequestEnabled': true,
  };
  m.workflowId = 'ci-wf-1';
  m.findFire.mockResolvedValue(fireRow());
  m.findRunInput.mockResolvedValue({ templateId: BUILTIN });
  m.findBuiltIn.mockResolvedValue({ id: BUILTIN });
  m.branchHeadSha.mockResolvedValue(FIX);
  m.findRepo.mockResolvedValue({
    id: CONN,
    organizationName: 'acme',
    repoName: 'api',
    team: { orgId: null },
    teamId: 'team-1',
  });
  m.pullRequestInfo.mockResolvedValue({
    headRef: BRANCH,
    headRepositoryFullName: 'acme/api',
    number: 7,
    state: 'open',
  });
  m.defaultBranch.mockResolvedValue('main');
  m.branchInfo.mockResolvedValue({ protected: false, sha: TIP });
  m.compareCommits.mockResolvedValue({
    aheadBy: 1,
    behindBy: 0,
    paths: ['src/sum.ts'],
    status: 'ahead',
  });
  m.updateFire.mockImplementation(async () => m.order.push('record'));
  m.fastForwardBranch.mockImplementation(async () => {
    m.order.push('push');
    return true;
  });
  m.deleteBranch.mockResolvedValue(true);
});

describe('pushCiFixToPullRequest', () => {
  it('records the commit, then fast-forwards the pull request branch to it', async () => {
    await expect(push()).resolves.toEqual({ branch: BRANCH, commitSha: FIX, pushed: true });
    expect(m.updateFire).toHaveBeenCalledWith({
      data: { fixCommitSha: FIX },
      where: { id: 'fire-1' },
    });
    expect(m.order).toEqual(['record', 'push']);
    expect(m.fastForwardBranch).toHaveBeenCalledWith(expect.anything(), BRANCH, FIX);
    expect(m.compareCommits).toHaveBeenCalledWith(expect.anything(), TIP, FIX);
    expect(m.deleteBranch).toHaveBeenCalledWith(expect.anything(), 'auto/ci-1-1');
    // The fire is the one this request started.
    expect(m.findFire.mock.calls[0]?.[0].where).toEqual({
      outcome: 'STARTED',
      workRequestId: 'wr-1',
    });
  });

  it.each<[string, () => void, RegExp]>([
    [
      'when an admin has not allowed it',
      () => {
        m.settings['github.ciFixPushToPullRequestEnabled'] = false;
      },
      /switched off/,
    ],
    ['for a run no trigger started', () => m.findFire.mockResolvedValue(null), /trigger started/],
    [
      'when the trigger, not the payload, does not ask for it',
      () =>
        m.findFire.mockResolvedValue(
          fireRow({ trigger: { connectionId: CONN, inputs: {}, templateId: null } })
        ),
      /does not ask/,
    ],
    [
      'for a trigger with its own template',
      () =>
        m.findFire.mockResolvedValue(
          fireRow({
            trigger: {
              connectionId: CONN,
              inputs: { pullRequestDelivery: 'push' },
              templateId: 't',
            },
          })
        ),
      /built-in/,
    ],
    [
      'for a re-run of the request (another workflow execution)',
      () => {
        m.workflowId = 'rerun-wf-2';
      },
      /trigger started/,
    ],
    [
      'outside an activity',
      () => {
        m.workflowId = undefined;
      },
      /trigger started/,
    ],
    [
      'for a run executing another template, even if the trigger now names the built-in',
      () => m.findRunInput.mockResolvedValue({ templateId: 'team-template' }),
      /built-in/,
    ],
    [
      'a commit that is not on the run’s work branch',
      () => m.branchHeadSha.mockResolvedValue('d'.repeat(40)),
      /work branch/,
    ],
    ['onto the default branch', () => m.defaultBranch.mockResolvedValue(BRANCH), /default branch/],
    [
      'onto a protected branch',
      () => m.branchInfo.mockResolvedValue({ protected: true, sha: TIP }),
      /protected/,
    ],
    [
      'onto a listed branch',
      () => {
        m.settings['github.ciFixNeverPushBranches'] = ['feature/**'];
      },
      /never pushed to/,
    ],
    [
      'when the pull request was closed',
      () =>
        m.pullRequestInfo.mockResolvedValue({
          headRef: BRANCH,
          headRepositoryFullName: 'acme/api',
          number: 7,
          state: 'closed',
        }),
      /no longer open/,
    ],
    [
      'when the pull request comes from a fork',
      () =>
        m.pullRequestInfo.mockResolvedValue({
          headRef: BRANCH,
          headRepositoryFullName: 'mallory/api',
          number: 7,
          state: 'open',
        }),
      /no longer open/,
    ],
    [
      'when the branch moved since the fix',
      () =>
        m.compareCommits.mockResolvedValue({
          aheadBy: 1,
          behindBy: 1,
          paths: ['src/sum.ts'],
          status: 'diverged',
        }),
      /moved/,
    ],
    [
      'a fix that touches a workflow file, in any case',
      () =>
        m.compareCommits.mockResolvedValue({
          aheadBy: 1,
          behindBy: 0,
          paths: ['src/sum.ts', '.GitHub/Workflows/ci.yml'],
          status: 'ahead',
        }),
      /workflow file/,
    ],
    [
      'a fix too large to list',
      () =>
        m.compareCommits.mockResolvedValue({
          aheadBy: 1,
          behindBy: 0,
          paths: null,
          status: 'ahead',
        }),
      /too large/,
    ],
    [
      'when GitHub refuses the fast-forward',
      () => m.fastForwardBranch.mockResolvedValue(false),
      /refused the push/,
    ],
  ])('refuses %s', async (_label, arrange, reason) => {
    arrange();
    const out = await push();
    expect(out).toMatchObject({ pushed: false, reason: expect.stringMatching(reason) });
    if (!/refused the push/.test(String(reason))) {
      expect(m.fastForwardBranch).not.toHaveBeenCalled();
    }
  });

  it('refuses a fix whose code result names another branch, and deletes nothing', async () => {
    const out = await pushCiFixToPullRequest({
      codeResult: { ...codeResult, branch: BRANCH },
      request: request(),
      triage: triage(),
    });
    expect(out).toMatchObject({ pushed: false, reason: expect.stringMatching(/work branch/) });
    expect(m.deleteBranch).not.toHaveBeenCalled();
  });

  it('matches the never-push list without case', async () => {
    m.settings['github.ciFixNeverPushBranches'] = ['release/**'];
    m.findFire.mockResolvedValue(fireRow({ headBranch: 'Release/2.0' }));
    const out = await pushCiFixToPullRequest({
      codeResult,
      request: request({ baseBranch: 'Release/2.0' }),
      triage: triage({
        run: { event: 'pull_request', headBranch: 'Release/2.0' } as CiTriageResult['run'],
      }),
    });
    expect(out).toMatchObject({ pushed: false, reason: expect.stringMatching(/never pushed to/) });
  });

  it('un-records the commit when GitHub refuses the push', async () => {
    m.fastForwardBranch.mockResolvedValue(false);
    await push();
    expect(m.updateFire.mock.calls.map((c) => c[0].data)).toEqual([
      { fixCommitSha: FIX },
      { fixCommitSha: null },
    ]);
  });

  it('answers pushed on a retry after a push whose reply was lost', async () => {
    m.findFire.mockResolvedValue(fireRow({ fixCommitSha: FIX }));
    m.branchInfo.mockResolvedValue({ protected: false, sha: FIX });
    await expect(push()).resolves.toEqual({ branch: BRANCH, commitSha: FIX, pushed: true });
    expect(m.fastForwardBranch).not.toHaveBeenCalled();
    expect(m.deleteBranch).toHaveBeenCalledWith(expect.anything(), 'auto/ci-1-1');
  });

  it('never pushes for a push-event failure, whatever the payload says', async () => {
    const out = await push({
      triage: triage({ run: { event: 'push', headBranch: BRANCH } as CiTriageResult['run'] }),
    });
    expect(out).toMatchObject({ pushed: false });
    expect(m.fastForwardBranch).not.toHaveBeenCalled();
  });

  it('does nothing for a run that was not asked to push', async () => {
    const out = await push({ request: request({ pullRequestDelivery: 'draft_pr' }) });
    expect(out).toMatchObject({ pushed: false });
    expect(m.findFire).not.toHaveBeenCalled();
  });
});
