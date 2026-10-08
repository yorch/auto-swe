import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunFailure } from '../lib/scm/types.js';

const m = vi.hoisted(() => ({
  branchHeadSha: vi.fn(),
  fetchWorkflowRunFailure: vi.fn(),
  findRepo: vi.fn(),
  pullRequestInfo: vi.fn(),
  runAgent: vi.fn(),
  scan: vi.fn(),
  upsertMarkedComment: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUniqueOrThrow: m.findRepo } },
}));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent: m.scan }));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => true) }));
vi.mock('../lib/execUtils.js', () => ({ withHeartbeat: (_l: string, p: Promise<unknown>) => p }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('../lib/config/agentSpec.js', () => ({ resolveAgentSpec: vi.fn(async (i: unknown) => i) }));
vi.mock('./runAgent.js', () => ({ runAgent: m.runAgent }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    branchHeadSha: m.branchHeadSha,
    fetchWorkflowRunFailure: m.fetchWorkflowRunFailure,
    pullRequestInfo: m.pullRequestInfo,
    upsertMarkedComment: m.upsertMarkedComment,
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));

import { redactCiLog } from '../lib/ciLogGuard.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import {
  CI_TRIAGE_COMMENT_MARKER,
  decide,
  neutralizeCommentText,
  refusalFor,
  renderTriageComment,
  reportCiTriage,
  triageCiFailure,
} from './ciTriage.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);

function failure(over: Partial<WorkflowRunFailure['run']> = {}): WorkflowRunFailure {
  return {
    failedJobs: [
      {
        conclusion: 'failure',
        failedSteps: ['Run tests'],
        htmlUrl: 'https://github.com/acme/api/actions/runs/1/job/2',
        log: 'FAIL src/sum.test.ts\n  expected 3, received 4',
        name: 'test',
      },
    ],
    run: {
      attempt: 1,
      conclusion: 'failure',
      event: 'push',
      headBranch: 'release/1.4',
      headRepositoryFullName: 'acme/api',
      headSha: SHA,
      htmlUrl: 'https://github.com/acme/api/actions/runs/1',
      id: '1',
      name: 'CI',
      path: '.github/workflows/ci.yml',
      pullRequests: [],
      repositoryFullName: 'acme/api',
      status: 'completed',
      ...over,
    },
  };
}

function request(payload: Record<string, unknown> = {}): RepoWorkRequest {
  return {
    description: 'Fix CI',
    externalTicketId: 'ci-1-1',
    payload: {
      baseBranch: 'release/1.4',
      connectionId: CONN,
      githubRunId: '1',
      mode: 'fix',
      runAttempt: 1,
      ...payload,
    },
    repoId: CONN,
    requestPayload: '{}',
    workRequestId: 'wr-1',
  } as RepoWorkRequest;
}

const verdict = {
  category: 'regression',
  confidence: 0.9,
  fixable: true,
  rootCause: 'sum() adds one',
  suggestedFix: 'remove the +1',
  summary: 'sum is off by one',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.findRepo.mockResolvedValue({ id: CONN, organizationName: 'acme', repoName: 'api' });
  m.fetchWorkflowRunFailure.mockResolvedValue(failure());
  m.branchHeadSha.mockResolvedValue(SHA);
  m.scan.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
  m.runAgent.mockResolvedValue({ object: verdict });
});

describe('refusalFor', () => {
  const payload = {
    baseBranch: 'release/1.4',
    connectionId: CONN,
    githubRunId: '1',
    mode: 'fix' as const,
    runAttempt: 1,
  };

  it('accepts a failed push run on the branch the run targets', () => {
    expect(refusalFor(failure(), payload, 'acme/api')).toBeNull();
  });

  it.each([
    ['another repository', { repositoryFullName: 'evil/api' }, /belongs to/],
    ['a run that did not fail', { conclusion: 'success' }, /did not fail/],
    ['a run still in progress', { conclusion: null, status: 'in_progress' }, /did not fail/],
    ['pull_request_target', { event: 'pull_request_target' }, /not acted on/],
    ['a schedule', { event: 'schedule' }, /not acted on/],
    ['a fork', { headRepositoryFullName: 'mallory/api' }, /fork/],
    ['a deleted fork', { headRepositoryFullName: null }, /fork/],
    ['another branch than the payload claims', { headBranch: 'main' }, /asked to target/],
  ])('refuses %s', (_label, over, re) => {
    expect(refusalFor(failure(over as never), payload, 'acme/api')).toMatch(re);
  });
});

describe('decide', () => {
  const base = {
    event: 'push',
    logsRead: true,
    mode: 'fix' as const,
    superseded: false,
    suspiciousLogs: false,
    verdict: { ...verdict, category: 'regression' as const },
  };

  it('fixes a confident, fixable regression in fix mode', () => {
    expect(decide(base).decision).toBe('fix');
  });

  it.each([
    ['triage-only mode', { mode: 'triage' as const }],
    ['no readable log', { logsRead: false }],
    ['logs that look like an injection', { suspiciousLogs: true }],
    ['a superseded pull request', { event: 'pull_request', superseded: true }],
    ['a flaky failure', { verdict: { ...verdict, category: 'flaky' as const } }],
    [
      'infrastructure, even if the model says fixable',
      { verdict: { ...verdict, category: 'infrastructure' as const, fixable: true } },
    ],
    [
      'a verdict that says not fixable',
      { verdict: { ...verdict, category: 'regression' as const, fixable: false } },
    ],
    [
      'low confidence',
      { verdict: { ...verdict, category: 'regression' as const, confidence: 0.3 } },
    ],
  ])('only reports for %s', (_label, over) => {
    expect(decide({ ...base, ...over }).decision).toBe('report');
  });

  it('still fixes a push failure on a branch that has moved: the fix is made on its tip', () => {
    expect(decide({ ...base, superseded: true }).decision).toBe('fix');
  });
});

describe('triageCiFailure', () => {
  it('reads the run by id from the run’s own repository and returns the decision', async () => {
    const out = await triageCiFailure({ request: request() });
    expect(m.fetchWorkflowRunFailure).toHaveBeenCalledWith(expect.anything(), '1', 1);
    expect(out).toMatchObject({ category: 'regression', decision: 'fix', superseded: false });
    expect(out.brief).toContain('expected 3, received 4');
    expect(out.run?.path).toBe('.github/workflows/ci.yml');
  });

  it('refuses a payload whose repository is not the run’s', async () => {
    await expect(
      triageCiFailure({
        request: { ...request(), repoId: '22222222-2222-4222-8222-222222222222' },
      })
    ).rejects.toMatchObject({ type: 'CI_TRIAGE_REPO_MISMATCH' });
  });

  it('refuses a payload with a URL instead of a run id', async () => {
    await expect(
      triageCiFailure({ request: request({ githubRunId: 'https://api.github.com/repos/x/y' }) })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'CI_TRIAGE_INVALID_PAYLOAD' });
    expect(m.fetchWorkflowRunFailure).not.toHaveBeenCalled();
  });

  it('skips a tag push without calling the model', async () => {
    m.branchHeadSha.mockResolvedValue(null);
    const out = await triageCiFailure({ request: request() });
    expect(out.decision).toBe('skip');
    expect(out.reason).toMatch(/not a branch/);
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it('skips a pull-request failure whose PR is closed', async () => {
    m.fetchWorkflowRunFailure.mockResolvedValue(
      failure({ event: 'pull_request', headBranch: 'feat/x' })
    );
    m.pullRequestInfo.mockResolvedValue({
      baseRef: 'main',
      headRef: 'feat/x',
      headRepositoryFullName: 'acme/api',
      headSha: SHA,
      htmlUrl: 'https://github.com/acme/api/pull/7',
      merged: false,
      number: 7,
      state: 'closed',
    });
    const out = await triageCiFailure({
      request: request({ baseBranch: 'feat/x', pullRequestNumber: 7 }),
    });
    expect(out.decision).toBe('skip');
  });

  it("falls back to the run's own pull request when the payload names none", async () => {
    m.fetchWorkflowRunFailure.mockResolvedValue(
      failure({
        event: 'pull_request',
        headBranch: 'feat/x',
        pullRequests: [{ baseRef: 'main', headRef: 'feat/x', number: 9 }],
      })
    );
    m.pullRequestInfo.mockResolvedValue({
      baseRef: 'main',
      headRef: 'feat/x',
      headRepositoryFullName: 'acme/api',
      headSha: SHA,
      htmlUrl: 'https://github.com/acme/api/pull/9',
      merged: false,
      number: 9,
      state: 'open',
    });
    const out = await triageCiFailure({ request: request({ baseBranch: 'feat/x' }) });
    expect(m.pullRequestInfo).toHaveBeenCalledWith(expect.anything(), 9);
    expect(out).toMatchObject({ decision: 'fix', pullRequestNumber: 9 });
  });

  it('says so when a pull-request failure names no pull request at all', async () => {
    m.fetchWorkflowRunFailure.mockResolvedValue(
      failure({ event: 'pull_request', headBranch: 'feat/x' })
    );
    const out = await triageCiFailure({ request: request({ baseBranch: 'feat/x' }) });
    expect(out).toMatchObject({
      decision: 'skip',
      reason: 'the run names no pull request from this branch',
    });
  });

  it('reports instead of fixing when the logs look like an injection', async () => {
    m.scan.mockResolvedValue({ incomplete: false, safe: false, warnings: ['injection:x'] });
    const out = await triageCiFailure({ request: request() });
    expect(out).toMatchObject({ decision: 'report', suspiciousLogs: true });
  });

  it('treats a scan that cannot complete as suspicious', async () => {
    m.scan.mockRejectedValue(new Error('scanner down'));
    const out = await triageCiFailure({ request: request() });
    expect(out.decision).toBe('report');
  });

  it('redacts credentials before the model sees the logs', async () => {
    m.fetchWorkflowRunFailure.mockResolvedValue({
      ...failure(),
      failedJobs: [
        {
          conclusion: 'failure',
          failedSteps: [],
          htmlUrl: null,
          log: `token ghp_${'x'.repeat(36)} leaked`,
          name: 'test',
        },
      ],
    });
    await triageCiFailure({ request: request() });
    const message = m.runAgent.mock.calls[0]?.[1] as string;
    expect(message).not.toContain(`ghp_${'x'.repeat(36)}`);
  });

  it('passes a step prompt override to the agent', async () => {
    await triageCiFailure({ request: request(), systemPromptOverride: 'be brief' });
    expect(vi.mocked(resolveAgentSpec)).toHaveBeenCalledWith(
      expect.objectContaining({ agentKey: 'ciTriager', promptOverride: 'be brief' }),
      expect.anything()
    );
  });
});

describe('redactCiLog', () => {
  it.each([
    `ghs_${'a'.repeat(36)}`,
    `github_pat_${'a'.repeat(40)}`,
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdef',
    '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  ])('redacts %s', (secret) => {
    expect(redactCiLog(`before ${secret} after`)).not.toContain(secret);
  });
});

describe('the pull request comment', () => {
  it('neutralises mentions, links and markdown in model text', () => {
    const out = neutralizeCommentText('@org/admins see [here](https://evil.example) <img src=x>');
    expect(out).not.toMatch(/@org/);
    expect(out).not.toContain('https://');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('](');
  });

  it('carries the marker and links only the fix PR URL the platform got back', () => {
    const body = renderTriageComment(
      {
        brief: '',
        category: 'regression',
        confidence: 0.9,
        decision: 'fix',
        failedJobs: [],
        fixable: true,
        pullRequestNumber: 7,
        reason: 'attempting a fix',
        rootCause: 'see https://evil.example',
        run: null,
        suggestedFix: '',
        summary: 'off by one',
        superseded: false,
        suspiciousLogs: false,
      },
      'https://github.com/acme/api/pull/8'
    );
    expect(body.startsWith(CI_TRIAGE_COMMENT_MARKER)).toBe(true);
    expect(body).toContain('https://github.com/acme/api/pull/8');
    expect(body).not.toContain('https://evil.example');
  });

  it('posts only when the payload asks and the failure has a PR, and never fails the run', async () => {
    const triage = await triageCiFailure({ request: request() });
    await expect(reportCiTriage({ request: request(), triage })).resolves.toEqual({
      commented: false,
    });
    m.upsertMarkedComment.mockRejectedValue(new Error('403'));
    await expect(
      reportCiTriage({
        request: request({ commentOnPullRequest: true }),
        triage: { ...triage, pullRequestNumber: 7 },
      })
    ).resolves.toMatchObject({ commented: false, error: '403' });
  });
});
