import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproverClientFailure, ApproverSession } from '../lib/scm/approverApp.js';
import type {
  BranchRules,
  PullRequestDetails,
  PullRequestReviewSummary,
  ScmProvider,
} from '../lib/scm/types.js';

const m = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
  connection: vi.fn(),
  created: [] as Record<string, unknown>[],
  evidence: { deploymentBad: 0, deploymentLow: 200, repoBad: 0, repoLow: 25, requesters: 5 },
  evidenceWheres: [] as Record<string, unknown>[],
  groupByArgs: [] as { by: string[]; where: Record<string, unknown> }[],
  invalidated: { count: 0 },
  logs: [] as { message: string; meta: unknown }[],
  markers: vi.fn(),
  onInvalidate: undefined as (() => void) | undefined,
  platformPr: vi.fn(),
  previous: vi.fn(),
  repoHost: { value: 'github.com' },
  request: vi.fn(),
  resolveSettingsCtx: [] as unknown[],
  runs: vi.fn(),
  settings: {} as Record<string, unknown>,
  steps: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  user: vi.fn(),
  users: {} as Record<string, { githubLogin: string | null; githubLoginAccountId: string | null }>,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findFirst: m.connection },
    prEvaluation: {
      count: vi.fn(async (args: { where: { badMerge?: boolean; connectionId?: string } }) => {
        m.evidenceWheres.push(args.where);
        const bad = args.where.badMerge === true;
        if (args.where.connectionId) {
          return bad ? m.evidence.repoBad : m.evidence.repoLow;
        }
        return bad ? m.evidence.deploymentBad : m.evidence.deploymentLow;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        m.created.push(args.data);
        return { id: `row-${m.created.length}` };
      }),
      findFirst: m.previous,
      findMany: vi.fn(async (args: unknown) => m.markers(args)),
      groupBy: vi.fn(async (args: { by: string[]; where: Record<string, unknown> }) => {
        m.groupByArgs.push(args);
        return Array.from({ length: m.evidence.requesters }, (_, i) => ({
          requesterId: `req-${i}`,
        }));
      }),
      update: m.update,
      updateMany: m.updateMany,
    },
    pullRequest: { findFirst: m.platformPr },
    runInput: { findUnique: m.request },
    user: { findMany: m.user },
    workflowRun: { findMany: m.runs },
    workflowStep: { findMany: m.steps },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  invalidateSettingsCache: vi.fn(() => {
    m.invalidated.count += 1;
    m.onInvalidate?.();
  }),
  resolveSettings: vi.fn(async (keys: string[], ctx: unknown) => {
    m.resolveSettingsCtx.push(ctx);
    return Object.fromEntries(keys.map((k) => [k, m.settings[k]]));
  }),
}));
vi.mock('../lib/activityLog.js', () => ({
  logError: (message: string, meta?: unknown) => m.logs.push({ message, meta }),
  logWarn: (message: string, meta?: unknown) => m.logs.push({ message, meta }),
}));
vi.mock('../lib/codeSecurityScanner.js', () => ({
  scanDiffForCodeIssuesDetailed: vi.fn(async () => ({ findings: [], incomplete: false })),
}));

import {
  BOT_APPROVAL_CONDITIONS,
  type BotApprovalCondition,
  DEFAULT_BOT_APPROVAL_PATHS,
} from '@auto-swe/shared/lib/prEvaluation';
import { ApplicationFailure } from '@temporalio/activity';
import {
  boundReasons,
  type EvaluatePullRequestDeps,
  evaluatePullRequestWith,
  expectedAppIdFor,
  isRetryableEvaluationError,
  loadMaxReviewSeverity,
} from './evaluatePullRequest.js';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const CONNECTION = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const SECRET = 'ghp_SuperSecretToken123456789';
const PATCH_TEXT = 'const patchBodyThatMustNeverBeLogged = 1;';
const LAUNCHER_LOGIN = 'launcher-login-xyz';
const LAUNCHER_ID = '424242';
const WORKFLOW_ID = 'eng-acme-widgets-JIRA-1';
const WORK_REQUEST = 'wr-1';
const POLICY_TEXT = 'version: 1\nsensitivePaths: ["policy-secret/**"]\n';

const DEFAULT_SETTINGS: Record<string, unknown> = {
  'prEvaluation.autoEvidenceMinChangedLines': 10,
  'prEvaluation.autoMergeAllowed': true,
  'prEvaluation.autoMinDistinctRequesters': 3,
  'prEvaluation.autoMinEvidence': 150,
  'prEvaluation.autoMinRepoEvidence': 20,
  'prEvaluation.botApprovalMaxFiles': 3,
  'prEvaluation.botApprovalMaxLines': 50,
  'prEvaluation.botApprovalPaths': ['src/**'],
  'prEvaluation.defaultMode': 'advisory',
  'prEvaluation.enabled': true,
  'prEvaluation.highApprovers': 2,
  'prEvaluation.highLines': 1000,
  'prEvaluation.lowApprovers': 1,
  'prEvaluation.maxLowDirs': 5,
  'prEvaluation.maxLowFiles': 15,
  'prEvaluation.maxLowLines': 400,
  'prEvaluation.requiredStatusContext': 'auto-swe/pr-evaluation',
  'prEvaluation.sensitivePaths': [],
  'prEvaluation.standardApprovers': 1,
};

const OPEN_PR: PullRequestDetails = {
  author: 'alice',
  autoMerge: { enabled: false },
  baseBranch: 'main',
  draft: false,
  headBranch: 'auto/JIRA-1',
  headSha: HEAD,
  merged: false,
  nodeId: 'PR_node',
  number: 7,
  state: 'open',
  title: 'Add helper',
};

const ALLOWS: BranchRules = {
  allowsAutoMerge: true,
  dismissStaleReviews: false,
  requiredReviewCount: 1,
  requiredStatusContexts: ['auto-swe/pr-evaluation'],
  requiredStatusPinnedToApp: true,
  requiresCodeOwnerReview: false,
  requiresReviews: true,
  source: 'protection',
};

function lowFiles(path = 'src/util.ts') {
  return [
    { additions: 10, deletions: 2, patch: `@@ -1 +1 @@\n+${PATCH_TEXT}`, path, status: 'modified' },
    {
      additions: 5,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+test',
      path: 'src/util.test.ts',
      status: 'modified',
    },
  ] as const;
}

type Fake = ScmProvider & { calls: string[] };

function fakeScm(over: Partial<Record<keyof ScmProvider, unknown>> = {}): Fake {
  const calls: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push(name);
      m.calls.push({ args, name });
      return value;
    };
  const base: Record<string, unknown> = {
    disableAutoMerge: track('disableAutoMerge', { ok: true }),
    dismissReview: track('dismissReview', { ok: true }),
    enableAutoMerge: track('enableAutoMerge', { ok: true }),
    fetchFileContent: track('fetchFileContent', null),
    getPullRequest: track('getPullRequest', OPEN_PR),
    listPullRequestFiles: track('listPullRequestFiles', {
      files: [...lowFiles()],
      truncated: false,
    }),
    listPullRequestReviews: track('listPullRequestReviews', [
      { commitId: HEAD, login: 'bob', state: 'APPROVED', submittedAt: null },
    ] satisfies PullRequestReviewSummary[]),
    readBranchRules: track('readBranchRules', ALLOWS),
    repoPermission: track('repoPermission', { ok: true, permission: 'write' }),
    setCommitStatus: track('setCommitStatus', { ok: true }),
    upsertMarkedComment: track('upsertMarkedComment', { htmlUrl: 'u', updated: false }),
  };
  for (const [k, v] of Object.entries(over)) {
    base[k] = v;
  }
  return Object.assign(base, { calls }) as unknown as Fake;
}

function depsWith(
  scm: Fake,
  scan?: EvaluatePullRequestDeps['scan'],
  expectedAppId: number | null = 4242
): EvaluatePullRequestDeps {
  return {
    expectedAppId: async () => expectedAppId,
    now: () => new Date('2026-10-29T12:00:00Z'),
    repoHost: async () => m.repoHost.value,
    scan: scan ?? (async () => ({ findings: [], incomplete: false })),
    scm,
  };
}

const INPUT = { connectionId: CONNECTION, prNumber: 7, trigger: 'pull_request.synchronize' };

function argsOf(name: string): unknown[][] {
  return m.calls.filter((c) => c.name === name).map((c) => c.args);
}

beforeEach(() => {
  m.calls = [];
  m.created.length = 0;
  m.logs.length = 0;
  m.resolveSettingsCtx.length = 0;
  m.invalidated.count = 0;
  m.onInvalidate = undefined;
  m.settings = { ...DEFAULT_SETTINGS };
  m.evidence = { deploymentBad: 0, deploymentLow: 200, repoBad: 0, repoLow: 25, requesters: 5 };
  m.evidenceWheres.length = 0;
  m.groupByArgs.length = 0;
  m.connection.mockReset();
  m.connection.mockResolvedValue({
    githubApiUrl: null,
    githubUrl: null,
    id: CONNECTION,
    installation: null,
    isActive: true,
    organizationName: 'acme',
    prEvaluationMode: null,
    repoName: 'widgets',
    team: { orgId: 'org-1' },
    teamId: 'team-1',
  });
  m.platformPr.mockReset();
  m.platformPr.mockResolvedValue({
    runId: 'run-1',
    workflow: { temporalWorkflowId: WORKFLOW_ID, workRequestId: WORK_REQUEST },
  });
  m.repoHost.value = 'github.com';
  // The launcher reads assert the ids they are asked about, and answer only for a user that
  // exists in the table: a lookup that resolved the wrong person gets nothing back.
  m.runs.mockReset();
  m.runs.mockImplementation(async (args: { where: { OR: unknown[] } }) => {
    expect(args.where.OR).toEqual([
      { id: 'run-1' },
      { workflowId: WORKFLOW_ID },
      { OR: [{ connectionId: null }, { connectionId: CONNECTION }], workRequestId: WORK_REQUEST },
    ]);
    return [{ launchedById: 'user-1' }];
  });
  m.request.mockReset();
  m.request.mockImplementation(async (args: { where: { id: string } }) => {
    expect(args.where).toEqual({ id: WORK_REQUEST });
    return { requestedById: 'user-1', requestedByServiceId: null };
  });
  m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: LAUNCHER_ID } };
  m.user.mockReset();
  m.user.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.flatMap((id) => (m.users[id] ? [{ id, ...m.users[id] }] : []))
  );
  m.previous.mockReset();
  m.previous.mockResolvedValue(null);
  m.steps.mockReset();
  m.steps.mockResolvedValue([
    { outputs: { codeResult: { headSha: HEAD }, verdicts: [{ severity: 'PASS' }] } },
  ]);
  m.update.mockReset();
  m.update.mockResolvedValue({});
  m.updateMany.mockReset();
  m.updateMany.mockResolvedValue({ count: 0 });
  m.markers.mockReset();
  m.markers.mockResolvedValue([]);
});

const ARMED = { ...OPEN_PR, autoMerge: { enabled: true, method: 'squash' } };

describe('evaluatePullRequest: skipped paths', () => {
  it('skips a missing or inactive repository', async () => {
    m.connection.mockResolvedValue(null);
    const scm = fakeScm();
    expect(await evaluatePullRequestWith(INPUT, depsWith(scm))).toMatchObject({
      outcome: 'skipped',
    });
    expect(scm.calls).toEqual([]);
  });

  it('disarms an armed pull request of a deactivated repository, like an off repository', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), isActive: false });
    m.previous.mockResolvedValue({
      autoMergeEnabled: true,
      headSha: HEAD,
      id: 'row-old',
      reasons: [],
    });
    const scm = fakeScm({ getPullRequest: async () => ARMED });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result).toMatchObject({ autoMerge: 'disabled', outcome: 'skipped' });
    expect(scm.calls).toEqual(['disableAutoMerge']);
    expect(m.created).toHaveLength(0);
  });

  it('makes no SCM call for a deactivated repository with no armed row', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), isActive: false });
    const scm = fakeScm();
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).outcome).toBe('skipped');
    expect(scm.calls).toEqual([]);
  });

  it('skips when the feature is switched off', async () => {
    m.settings['prEvaluation.enabled'] = false;
    const scm = fakeScm();
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).outcome).toBe('skipped');
    expect(scm.calls).toEqual([]);
  });

  it('skips when the repository mode is off, and when the inherited default is off', async () => {
    m.connection.mockResolvedValueOnce({
      ...(await m.connection()),
      prEvaluationMode: 'off',
    });
    expect((await evaluatePullRequestWith(INPUT, depsWith(fakeScm()))).outcome).toBe('skipped');
    m.settings['prEvaluation.defaultMode'] = 'off';
    expect((await evaluatePullRequestWith(INPUT, depsWith(fakeScm()))).outcome).toBe('skipped');
  });

  it('lets the repository mode override an off default', async () => {
    m.settings['prEvaluation.defaultMode'] = 'off';
    m.connection.mockResolvedValue({
      ...(await m.connection()),
      prEvaluationMode: 'advisory',
    });
    expect((await evaluatePullRequestWith(INPUT, depsWith(fakeScm()))).outcome).toBe('evaluated');
  });

  it('skips a pull request the host does not know', async () => {
    const scm = fakeScm({ getPullRequest: async () => null });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).outcome).toBe('skipped');
  });

  it('skips a pull request the platform did not open', async () => {
    m.platformPr.mockResolvedValue(null);
    const scm = fakeScm();
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.outcome).toBe('skipped');
    expect(scm.calls).not.toContain('setCommitStatus');
    expect(m.created).toHaveLength(0);
  });

  it.each([
    ['closed', { merged: false, state: 'closed' }],
    ['merged', { merged: true, state: 'closed' }],
  ] as const)('skips a %s pull request', async (_n, patch) => {
    const scm = fakeScm({ getPullRequest: async () => ({ ...OPEN_PR, ...patch }) });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).outcome).toBe('skipped');
    expect(m.created).toHaveLength(0);
  });
});

describe('evaluatePullRequest: settings scope', () => {
  it('resolves settings with the connection team and its organization', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(m.resolveSettingsCtx[0]).toEqual({ orgId: 'org-1', teamId: 'team-1' });
  });
});

describe('evaluatePullRequest: signals', () => {
  it('reads the policy file from the base branch, never the head', async () => {
    const scm = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(argsOf('fetchFileContent')).toEqual([
      [expect.anything(), '.auto-swe/pr-policy.yml', 'main'],
    ]);
    expect(JSON.stringify(argsOf('fetchFileContent'))).not.toContain(HEAD);
    expect(JSON.stringify(argsOf('fetchFileContent'))).not.toContain('auto/JIRA-1');
  });

  it('fails closed on a policy file that does not parse', async () => {
    const scm = fakeScm({ fetchFileContent: async () => ': : not yaml [' });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.riskClass).toBe('HIGH');
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('policy-file-invalid');
  });

  it('fails closed on a truncated file list', async () => {
    const scm = fakeScm({
      listPullRequestFiles: async () => ({ files: [...lowFiles()], truncated: true }),
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.riskClass).toBe('HIGH');
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('file list truncated');
  });

  it('treats a change to the policy file, by either path of a rename, as a hard exclusion', async () => {
    const scm = fakeScm({
      listPullRequestFiles: async () => ({
        files: [
          {
            additions: 0,
            deletions: 0,
            path: 'docs/policy.yml',
            previousPath: '.auto-swe/pr-policy.yml',
            similarity: 100,
            status: 'renamed',
          },
        ],
        truncated: false,
      }),
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.riskClass).toBe('HIGH');
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('policy-file-changed');
  });

  it('forces HIGH on any scanner finding and on an incomplete or failed scan', async () => {
    for (const scan of [
      async () => ({ findings: [{}], incomplete: false }),
      async () => ({ findings: [], incomplete: true }),
      async () => {
        throw new Error(`boom ${SECRET}`);
      },
    ]) {
      m.created.length = 0;
      const result = await evaluatePullRequestWith(INPUT, depsWith(fakeScm(), scan));
      expect(result.riskClass).toBe('HIGH');
    }
  });

  it('fails closed to HIGH when no review verdict is recorded', async () => {
    m.steps.mockResolvedValue([]);
    expect((await evaluatePullRequestWith(INPUT, depsWith(fakeScm()))).riskClass).toBe('HIGH');
  });

  it('classifies a small reviewed change with tests as LOW', async () => {
    const result = await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(result).toMatchObject({ outcome: 'evaluated', riskClass: 'LOW' });
  });

  it('never scans the repository policy text into the scanner input or the logs', async () => {
    const scanned: string[] = [];
    const scm = fakeScm({ fetchFileContent: async () => POLICY_TEXT });
    await evaluatePullRequestWith(
      INPUT,
      depsWith(scm, async (diff) => {
        scanned.push(diff);
        return { findings: [], incomplete: false };
      })
    );
    expect(scanned[0]).toContain(PATCH_TEXT);
    expect(scanned[0]).not.toContain('policy-secret');
    expect(JSON.stringify(m.logs)).not.toContain('policy-secret');
  });
});

describe('loadMaxReviewSeverity', () => {
  const step = (headSha: string, severities: unknown[]) => ({
    outputs: { codeResult: { headSha }, verdicts: severities.map((severity) => ({ severity })) },
  });

  it('is the highest severity of the verdicts for exactly this head', async () => {
    m.steps.mockResolvedValue([step(HEAD, ['PASS', 'WARNING', 'INFO'])]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBe('WARNING');
  });

  it('is null when the network reviewed another commit (a later push is unreviewed)', async () => {
    m.steps.mockResolvedValue([step(OLD_HEAD, ['PASS'])]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBeNull();
  });

  it('is null when nothing was recorded, a verdict is malformed, or there are no verdicts', async () => {
    m.steps.mockResolvedValue([]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBeNull();
    m.steps.mockResolvedValue([step(HEAD, ['PASS', 'LGTM'])]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBeNull();
    m.steps.mockResolvedValue([step(HEAD, [])]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBeNull();
    m.steps.mockResolvedValue([{ outputs: null }]);
    expect(await loadMaxReviewSeverity('wf', HEAD)).toBeNull();
  });

  it('reads the review steps of the run the pull request links', async () => {
    m.steps.mockResolvedValue([]);
    await loadMaxReviewSeverity('eng-acme-widgets-JIRA-1', HEAD);
    expect(m.steps.mock.calls[0]?.[0]).toMatchObject({
      where: { run: { workflowId: 'eng-acme-widgets-JIRA-1' }, stepName: 'runReviewNetwork' },
    });
  });
});

describe('evaluatePullRequest: approvals and status', () => {
  const approvals = (n: number, commitId = HEAD) =>
    Array.from({ length: n }, (_v, i) => ({
      commitId,
      login: `reviewer${i}`,
      state: 'APPROVED',
      submittedAt: null,
    }));

  it('advisory mode is always success, with or without approvals', async () => {
    for (const reviews of [[], approvals(1)]) {
      const scm = fakeScm({ listPullRequestReviews: async () => reviews });
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(result.statusState).toBe('success');
    }
  });

  it('auto mode is pending until enough approvals on this head exist', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
    const pending = await evaluatePullRequestWith(
      INPUT,
      depsWith(fakeScm({ listPullRequestReviews: async () => [] }))
    );
    expect(pending.statusState).toBe('pending');
    const stale = await evaluatePullRequestWith(
      INPUT,
      depsWith(fakeScm({ listPullRequestReviews: async () => approvals(1, OLD_HEAD) }))
    );
    expect(stale.statusState).toBe('pending');
    const ok = await evaluatePullRequestWith(
      INPUT,
      depsWith(fakeScm({ listPullRequestReviews: async () => approvals(1) }))
    );
    expect(ok.statusState).toBe('success');
  });

  describe('enforce mode', () => {
    const enforceRepo = async () => {
      m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'enforce' });
    };

    it('is pending with no approvals and success once enough approvals on this head exist', async () => {
      await enforceRepo();
      const pending = await evaluatePullRequestWith(
        INPUT,
        depsWith(fakeScm({ listPullRequestReviews: async () => [] }))
      );
      expect(pending.statusState).toBe('pending');
      const stale = await evaluatePullRequestWith(
        INPUT,
        depsWith(fakeScm({ listPullRequestReviews: async () => approvals(1, OLD_HEAD) }))
      );
      expect(stale.statusState).toBe('pending');
      const ok = await evaluatePullRequestWith(
        INPUT,
        depsWith(fakeScm({ listPullRequestReviews: async () => approvals(1) }))
      );
      expect(ok.statusState).toBe('success');
      expect(m.created.at(-1)).toMatchObject({ mode: 'enforce', statusState: 'success' });
    });

    it('does not count an approver without write access', async () => {
      await enforceRepo();
      const scm = fakeScm({
        listPullRequestReviews: async () => approvals(1),
        repoPermission: async () => ({ ok: true, permission: 'read' }),
      });
      expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).statusState).toBe('pending');
    });

    it('never arms auto-merge, even when every auto condition holds', async () => {
      await enforceRepo();
      const scm = fakeScm({ listPullRequestReviews: async () => approvals(1) });
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(result.autoMerge).toBe('not-eligible');
      expect(scm.calls).not.toContain('enableAutoMerge');
    });

    it('disarms an auto-merge GitHub shows enabled', async () => {
      await enforceRepo();
      const scm = fakeScm({
        getPullRequest: async () => ARMED,
        listPullRequestReviews: async () => approvals(1),
      });
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(result.autoMerge).toBe('disabled');
      expect(scm.calls).toContain('disableAutoMerge');
      expect(scm.calls).not.toContain('enableAutoMerge');
    });

    it('is the default mode of a repository that has not chosen one', async () => {
      m.settings['prEvaluation.defaultMode'] = 'enforce';
      const result = await evaluatePullRequestWith(
        INPUT,
        depsWith(fakeScm({ listPullRequestReviews: async () => [] }))
      );
      expect(result.statusState).toBe('pending');
    });

    // The real database rejects an unknown mode string (CHECK constraint), so in production this
    // evaluation fails closed to a `failure` status with no stored row. The mock has no CHECK, so
    // this asserts the strict status rules, not the production path.
    it('applies the strict status rules to a mode it does not recognise, arming nothing', async () => {
      m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'mystery' });
      const scm = fakeScm({ listPullRequestReviews: async () => [] });
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(result.statusState).toBe('pending');
      expect(scm.calls).not.toContain('enableAutoMerge');
    });
  });

  it('publishes the status under the configured context for the evaluated head', async () => {
    m.settings['prEvaluation.requiredStatusContext'] = 'ci/custom';
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    const [, sha, status] = argsOf('setCommitStatus')[0] as [unknown, string, { context: string }];
    expect(sha).toBe(HEAD);
    expect(status.context).toBe('ci/custom');
    const [, number, marker] = argsOf('upsertMarkedComment')[0] as [unknown, number, string];
    expect(number).toBe(7);
    expect(marker).toBe('<!-- auto-swe:pr-evaluation -->');
  });

  it('persists one row per evaluation with the readiness it read', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({
      baseBranch: 'main',
      connectionId: CONNECTION,
      headSha: HEAD,
      mode: 'advisory',
      prNumber: 7,
      readiness: { ...ALLOWS, statusPublished: { ok: true } },
      riskClass: 'LOW',
      triggeredBy: 'pull_request.synchronize',
    });
  });
});

describe('evaluatePullRequest: the facts the evidence gate counts', () => {
  it('persists the requester, the changed lines and the trusted approver count', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    // 10 + 2 + 5 + 0 changed lines over the listed files; bob's approval is the one trusted one.
    expect(m.created[0]).toMatchObject({
      changedLines: 17,
      requesterId: 'user-1',
      trustedApprovers: 1,
    });
  });

  it('persists a null requester when the work has no user requester', async () => {
    m.request.mockImplementation(async () => ({
      requestedById: null,
      requestedByServiceId: 'svc',
    }));
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(m.created[0]).toMatchObject({ requesterId: null });
  });

  it('persists zero trusted approvers when nobody trusted approved', async () => {
    await evaluatePullRequestWith(
      INPUT,
      depsWith(fakeScm({ listPullRequestReviews: async () => [] }))
    );
    expect(m.created[0]).toMatchObject({ trustedApprovers: 0 });
  });

  describe('the approval fact leaves the launchers out only when they are all known', () => {
    const approval = (login: string, userId?: string): PullRequestReviewSummary => ({
      commitId: HEAD,
      login,
      state: 'APPROVED',
      submittedAt: null,
      ...(userId ? { userId } : {}),
    });

    it('stores 0 when the launcher set is unresolved, even though a trusted human approved', async () => {
      // The requester never linked GitHub, so the launcher's own approval cannot be told apart.
      m.users = { 'user-1': { githubLogin: null, githubLoginAccountId: null } };
      const scm = fakeScm({
        listPullRequestReviews: async () => [approval('bob', '7'), approval('requester-login')],
      });
      await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(m.created[0]?.trustedApprovers).toBe(0);
    });

    it('stores 0 when the launcher alone approved (resolved set, set aside by id)', async () => {
      const scm = fakeScm({
        listPullRequestReviews: async () => [approval('renamed-since', LAUNCHER_ID)],
      });
      await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(m.created[0]?.trustedApprovers).toBe(0);
    });

    it('stores 1 when a second human approves next to the launcher (resolved set)', async () => {
      const scm = fakeScm({
        listPullRequestReviews: async () => [
          approval(LAUNCHER_LOGIN, LAUNCHER_ID),
          approval('bob', '7'),
        ],
      });
      await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(m.created[0]?.trustedApprovers).toBe(1);
    });
  });

  it('never logs, posts or publishes the requester', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    const out = JSON.stringify([m.logs, m.calls]);
    expect(out).not.toContain('user-1');
  });

  it('reads the evidence with the configured line minimum and this repository', async () => {
    m.settings['prEvaluation.autoEvidenceMinChangedLines'] = 25;
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(m.evidenceWheres.length).toBeGreaterThan(0);
    expect(m.evidenceWheres.some((w) => w.connectionId === CONNECTION)).toBe(true);
    // The requester count is a database grouping over the very filter the merge counts use.
    expect(m.groupByArgs).toHaveLength(1);
    expect(m.groupByArgs[0]?.by).toEqual(['requesterId']);
    expect(m.groupByArgs[0]?.where).toMatchObject({
      badMerge: false,
      changedLines: { gte: 25 },
      requesterId: { not: null },
      trustedApprovers: { gte: 1 },
    });
    expect(m.groupByArgs[0]?.where.connectionId).toBeUndefined();
    expect(
      m.evidenceWheres.every(
        (w) => w.badMerge === true || (w.changedLines as { gte: number }).gte === 25
      )
    ).toBe(true);
  });
});

describe('evaluatePullRequest: the evidence gate refuses arming with every unmet reason', () => {
  it('names each unmet condition and nothing that identifies a person', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
    m.evidence = { deploymentBad: 1, deploymentLow: 10, repoBad: 1, repoLow: 0, requesters: 1 };
    const scm = fakeScm();
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('not-eligible');
    expect(scm.calls).not.toContain('enableAutoMerge');
    const reasons = m.created[0]?.reasons as { code: string; message: string }[];
    const blocked = reasons.find((r) => r.code === 'auto-merge-blocked')?.message ?? '';
    expect(blocked).toContain('deployment-wide');
    expect(blocked).toContain('this repository');
    expect(blocked).toContain('distinct requester');
    expect(blocked).not.toContain('user-1');
    expect(blocked).not.toContain('req-');
  });
});

describe('evaluatePullRequest: the merge-time recount', () => {
  const MERGED = { ...OPEN_PR, merged: true, state: 'closed' as const };
  const MERGE_INPUT = { connectionId: CONNECTION, prNumber: 7, trigger: 'merged' };
  const approved = (login: string, userId?: string): PullRequestReviewSummary => ({
    commitId: HEAD,
    login,
    state: 'APPROVED',
    submittedAt: null,
    ...(userId ? { userId } : {}),
  });
  const REVIEWS = [{ commitId: HEAD, login: 'bob', state: 'DISMISSED', submittedAt: null }];
  const written = () =>
    m.update.mock.calls.map((c) => c[0] as { data: Record<string, unknown>; where: unknown });

  beforeEach(() => {
    // The one row the merge webhook stamped.
    m.previous.mockResolvedValue({ headSha: HEAD, id: 'row-merged' });
  });

  const ALLOWED_CALLS = ['getPullRequest', 'listPullRequestReviews', 'repoPermission'];

  it('corrects a row whose approval was dismissed before an admin bypass-merge to 0', async () => {
    const scm = fakeScm({
      getPullRequest: async () => MERGED,
      listPullRequestReviews: async () => REVIEWS,
    });
    const result = await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(result.outcome).toBe('skipped');
    expect(written()).toEqual([{ data: { trustedApprovers: 0 }, where: { id: 'row-merged' } }]);
    expect(m.previous.mock.calls[0]?.[0]).toMatchObject({
      where: { connectionId: CONNECTION, mergedAt: { not: null }, prNumber: 7 },
    });
  });

  it('writes the recounted 1 when the approval still stands', async () => {
    const scm = fakeScm({ getPullRequest: async () => MERGED });
    await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(written()).toEqual([{ data: { trustedApprovers: 1 }, where: { id: 'row-merged' } }]);
  });

  it('sets the launcher approval aside, as the evaluation does', async () => {
    const alone = fakeScm({
      getPullRequest: async () => MERGED,
      listPullRequestReviews: async () => [approved(LAUNCHER_LOGIN, LAUNCHER_ID)],
    });
    await evaluatePullRequestWith(MERGE_INPUT, depsWith(alone));
    expect(written().at(-1)?.data).toEqual({ trustedApprovers: 0 });
    const withSecond = fakeScm({
      getPullRequest: async () => MERGED,
      listPullRequestReviews: async () => [
        approved(LAUNCHER_LOGIN, LAUNCHER_ID),
        approved('bob', '7'),
      ],
    });
    await evaluatePullRequestWith(MERGE_INPUT, depsWith(withSecond));
    expect(written().at(-1)?.data).toEqual({ trustedApprovers: 1 });
  });

  it('writes 0 when the launcher set is unresolved', async () => {
    m.users = { 'user-1': { githubLogin: null, githubLoginAccountId: null } };
    const scm = fakeScm({ getPullRequest: async () => MERGED });
    await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(written()).toEqual([{ data: { trustedApprovers: 0 }, where: { id: 'row-merged' } }]);
  });

  it('returns without writing or calling the host when no row was stamped, logging no ids', async () => {
    m.previous.mockResolvedValue(null);
    const scm = fakeScm({ getPullRequest: async () => MERGED });
    const result = await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(result.outcome).toBe('skipped');
    expect(written()).toHaveLength(0);
    expect(scm.calls).toEqual([]);
    expect(JSON.stringify(m.logs)).not.toContain(CONNECTION);
  });

  it.each([
    [
      'the pull request cannot be read',
      {
        getPullRequest: async () => {
          throw Object.assign(new Error('boom'), { status: 404 });
        },
      },
    ],
    [
      'the host is unavailable',
      {
        getPullRequest: async () => {
          throw Object.assign(new Error('boom'), { status: 503 });
        },
      },
    ],
    [
      'the reviews cannot be listed',
      {
        getPullRequest: async () => MERGED,
        listPullRequestReviews: async () => {
          throw new Error('boom');
        },
      },
    ],
    ['the pull request is not merged after all', { getPullRequest: async () => OPEN_PR }],
  ])('fails closed to 0 when %s, and never throws', async (_name, over) => {
    const scm = fakeScm(over);
    const result = await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(result.outcome).toBe('skipped');
    expect(written()).toEqual([{ data: { trustedApprovers: 0 }, where: { id: 'row-merged' } }]);
  });

  it('publishes nothing, posts nothing, arms and disarms nothing, and creates no row', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
    const scm = fakeScm({ getPullRequest: async () => MERGED });
    await evaluatePullRequestWith(MERGE_INPUT, depsWith(scm));
    expect(scm.calls.filter((c) => !ALLOWED_CALLS.includes(c))).toEqual([]);
    expect(m.created).toHaveLength(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('does not touch a row for any other trigger of a merged pull request', async () => {
    const scm = fakeScm({ getPullRequest: async () => MERGED });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).outcome).toBe('skipped');
    expect(written()).toHaveLength(0);
  });
});

describe('evaluatePullRequest: the expected App id', () => {
  it('reads the branch rules against the platform App id the credential resolves to', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm(), undefined, 4242));
    const [, branch, context, appId] = argsOf('readBranchRules')[0] as unknown[];
    expect([branch, context, appId]).toEqual(['main', 'auto-swe/pr-evaluation', 4242]);
  });

  it('passes null when no App id is known, and a failed resolution reads as null', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm(), undefined, null));
    expect(argsOf('readBranchRules')[0]?.[3]).toBeNull();
    m.calls = [];
    const deps = depsWith(fakeScm());
    await evaluatePullRequestWith(INPUT, {
      ...deps,
      expectedAppId: async () => {
        throw new Error('decrypt failed');
      },
    });
    expect(argsOf('readBranchRules')[0]?.[3]).toBeNull();
  });
});

describe('expectedAppIdFor', () => {
  const repo = {
    installationHost: null,
    installationId: null,
    organizationName: 'acme',
    repoName: 'widgets',
  };
  const config = (over: Record<string, unknown> = {}) =>
    ({
      appId: '123456',
      appInstallationId: '99',
      appPrivateKey: 'pem',
      authMode: 'auto',
      token: 'ghp_x',
      ...over,
    }) as never;
  const via = (cfg: unknown, scope: string = 'instance') => ({
    credential: async () => ({ config: cfg, scope }) as never,
    loadConfig: async () => cfg as never,
  });

  it('is the numeric App id when the credential is an App', async () => {
    expect(await expectedAppIdFor(repo, via(config()))).toBe(123456);
  });

  it('uses the config the credential resolved, a host set included', async () => {
    const own = config({ appId: '777' });
    const d = {
      credential: async () => ({ config: own, host: 'h', scope: 'host' }) as never,
      loadConfig: async () => config(),
    };
    expect(await expectedAppIdFor(repo, d)).toBe(777);
  });

  it('is null for a personal access token, a missing id, or a repository with no credential', async () => {
    expect(await expectedAppIdFor(repo, via(config({ authMode: 'pat' })))).toBeNull();
    expect(await expectedAppIdFor(repo, via(config({ appPrivateKey: null })))).toBeNull();
    expect(await expectedAppIdFor(repo, via(config({ appId: null })))).toBeNull();
    expect(await expectedAppIdFor(repo, via(config({ appId: 'abc' })))).toBeNull();
    expect(await expectedAppIdFor(repo, via(config(), 'mismatch'))).toBeNull();
  });

  it('is the App id in app mode even when no installation id is configured', async () => {
    expect(
      await expectedAppIdFor(repo, via(config({ appInstallationId: null, authMode: 'app' })))
    ).toBe(123456);
  });
});

describe('evaluatePullRequest: only trusted approvers count', () => {
  const approve = (login: string) => ({
    commitId: HEAD,
    login,
    state: 'APPROVED',
    submittedAt: null,
  });
  const permissionOf =
    (table: Record<string, unknown>) => async (_repo: unknown, login: string) => {
      m.calls.push({ args: [login], name: 'repoPermission' });
      const v = table[login];
      if (v instanceof Error) {
        throw v;
      }
      return v ?? { ok: true, permission: 'write' };
    };
  const autoRepo = async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
  };

  it('does not count an approval from a reader, and says how many were not counted', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [approve('outsider')],
      repoPermission: permissionOf({ outsider: { ok: true, permission: 'read' } }),
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
    const reasons = m.created[0]?.reasons as { code: string; message: string }[];
    const note = reasons.find((r) => r.code === 'approvers-unverified');
    expect(note?.message).toMatch(/\b1\b/);
    expect(JSON.stringify(reasons)).not.toContain('outsider');
  });

  it('counts a writer, and records no note when every approver qualified', async () => {
    await autoRepo();
    const scm = fakeScm({ listPullRequestReviews: async () => [approve('maintainer')] });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('success');
    const reasons = m.created[0]?.reasons as { code: string }[];
    expect(reasons.some((r) => r.code === 'approvers-unverified')).toBe(false);
  });

  it.each([
    ['a lookup error', new Error('boom')],
    ['an unreadable permission', { failure: 'rate-limited', ok: false }],
    ['permission none', { ok: true, permission: 'none' }],
  ])('fails closed on %s', async (_n, answer) => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [approve('someone')],
      repoPermission: permissionOf({ someone: answer }),
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
  });

  it('never looks up the PR author', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [approve('alice'), approve('bob')],
    });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(argsOf('repoPermission').map((a) => a[1] ?? a[0])).not.toContain('alice');
  });

  it('looks up at most 20 distinct approvers, in review order', async () => {
    await autoRepo();
    const many = Array.from({ length: 25 }, (_v, i) => approve(`user${i}`));
    const scm = fakeScm({ listPullRequestReviews: async () => [...many, approve('user0')] });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    const looked = argsOf('repoPermission').map((a) => String(a[1] ?? a[0]));
    expect(looked).toHaveLength(20);
    expect(looked[0]).toBe('user0');
    expect(looked).not.toContain('user20');
  });
});

describe('evaluatePullRequest: auto-merge', () => {
  const autoRepo = async (over: Record<string, unknown> = {}) => {
    m.connection.mockResolvedValue({
      ...(await m.connection()),
      prEvaluationMode: 'auto',
      ...over,
    });
  };

  it('enables auto-merge by squash, pinned to the evaluated head, when every condition holds', async () => {
    await autoRepo();
    const scm = fakeScm();
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('enabled');
    expect(argsOf('enableAutoMerge')).toEqual([
      [expect.anything(), 7, { expectedHeadSha: HEAD, method: 'SQUASH' }],
    ]);
    expect(m.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ autoMergeEnabled: true }),
      where: { id: 'row-1' },
    });
    // The status first, then the brief, then the arming.
    expect(scm.calls.indexOf('setCommitStatus')).toBeLessThan(
      scm.calls.indexOf('upsertMarkedComment')
    );
    expect(scm.calls.indexOf('upsertMarkedComment')).toBeLessThan(
      scm.calls.indexOf('enableAutoMerge')
    );
    expect(JSON.stringify(m.update.mock.calls)).toContain('auto-armed');
  });

  const negatives: [
    string,
    () => void | Promise<void>,
    Partial<Record<keyof ScmProvider, unknown>>,
  ][] = [
    [
      'deployment does not allow auto-merge',
      () => {
        m.settings['prEvaluation.autoMergeAllowed'] = false;
      },
      {},
    ],
    [
      'repository mode is advisory',
      async () => {
        m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'advisory' });
      },
      {},
    ],
    [
      'class is STANDARD',
      () => undefined,
      {
        listPullRequestFiles: async () => ({
          files: [
            { additions: 500, deletions: 0, patch: '@@\n+x', path: 'src/a.ts', status: 'modified' },
          ],
          truncated: false,
        }),
      },
    ],
    [
      'a hard exclusion (sensitive path) applies',
      () => undefined,
      {
        listPullRequestFiles: async () => ({
          files: [...lowFiles('db/migrations/001.sql')],
          truncated: false,
        }),
      },
    ],
    [
      'the repository forbids auto-merge',
      () => undefined,
      {
        readBranchRules: async () => ({ ...ALLOWS, allowsAutoMerge: false }),
      },
    ],
    [
      'whether the repository allows auto-merge is unknown',
      () => undefined,
      {
        readBranchRules: async () => ({ ...ALLOWS, allowsAutoMerge: 'unknown' }),
      },
    ],
    [
      'the required status is not pinned to a GitHub App',
      () => undefined,
      { readBranchRules: async () => ({ ...ALLOWS, requiredStatusPinnedToApp: false }) },
    ],
    [
      'whether the required status is pinned is unknown',
      () => undefined,
      { readBranchRules: async () => ({ ...ALLOWS, requiredStatusPinnedToApp: 'unknown' }) },
    ],
    [
      'our status is not a required check',
      () => undefined,
      { readBranchRules: async () => ({ ...ALLOWS, requiredStatusContexts: ['ci'] }) },
    ],
    [
      'the required checks are unknown',
      () => undefined,
      { readBranchRules: async () => ({ ...ALLOWS, requiredStatusContexts: 'unknown' }) },
    ],
    [
      'the host refused the commit status',
      () => undefined,
      { setCommitStatus: async () => ({ ok: false, reason: 'no permission' }) },
    ],
    [
      'reviews are not required and nobody has approved',
      () => undefined,
      {
        listPullRequestReviews: async () => [],
        readBranchRules: async () => ({ ...ALLOWS, requiresReviews: false }),
      },
    ],
    [
      'the pull request is a draft',
      () => undefined,
      { getPullRequest: async () => ({ ...OPEN_PR, draft: true }) },
    ],
    [
      'branch rules cannot be read',
      () => undefined,
      {
        readBranchRules: async () => {
          throw new Error('no admin access');
        },
      },
    ],
    [
      'evidence is below the minimum',
      () => {
        m.evidence = { ...m.evidence, deploymentLow: 149 };
      },
      {},
    ],
    [
      'a bad merge is on record',
      () => {
        m.evidence = { ...m.evidence, deploymentBad: 1, deploymentLow: 500 };
      },
      {},
    ],
    [
      'this repository has too little evidence',
      () => {
        m.evidence = { ...m.evidence, repoLow: 19 };
      },
      {},
    ],
    [
      'this repository has a bad merge',
      () => {
        m.evidence = { ...m.evidence, repoBad: 1 };
      },
      {},
    ],
    [
      'too few distinct requesters',
      () => {
        m.evidence = { ...m.evidence, requesters: 2 };
      },
      {},
    ],
    [
      'no review verdict is on record',
      () => {
        m.steps.mockResolvedValue([]);
      },
      {},
    ],
  ];

  it.each(negatives)('does not enable when %s', async (_name, arrange, scmOver) => {
    await autoRepo();
    await arrange();
    const scm = fakeScm(scmOver);
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.outcome).toBe('evaluated');
    expect(result.autoMerge).toBe('not-eligible');
    expect(scm.calls).not.toContain('enableAutoMerge');
  });

  it('keeps auto status rules when auto-merge is globally off: pending until approved, never armed', async () => {
    await autoRepo();
    m.settings['prEvaluation.autoMergeAllowed'] = false;
    const scm = fakeScm({ listPullRequestReviews: async () => [] });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
    expect(result.autoMerge).toBe('not-eligible');
    expect(m.created[0]?.mode).toBe('auto');
    expect(m.created[0]?.statusState).toBe('pending');
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('auto-merge-globally-disabled');
    expect(scm.calls).not.toContain('enableAutoMerge');
  });

  it('never marks a draft ready: a draft is simply not eligible, with the reason draft', async () => {
    await autoRepo();
    const scm = fakeScm({ getPullRequest: async () => ({ ...OPEN_PR, draft: true }) });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('not-eligible');
    expect(scm.calls).not.toContain('enableAutoMerge');
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('draft');
  });

  it('records whether the status was published in the readiness, and arms only on success', async () => {
    await autoRepo();
    const refused = fakeScm({
      setCommitStatus: async () => ({ ok: false, reason: 'secret host text' }),
    });
    await evaluatePullRequestWith(INPUT, depsWith(refused));
    expect(m.created[0]?.readiness).toMatchObject({
      allowsAutoMerge: true,
      statusPublished: { ok: false },
    });
    expect(JSON.stringify(m.created[0]?.readiness)).not.toContain('secret host text');
    expect(refused.calls).not.toContain('enableAutoMerge');
  });

  it('disables an arming GitHub shows when a condition no longer holds, whatever the database says', async () => {
    await autoRepo();
    m.steps.mockResolvedValue([]); // the new head is unreviewed
    const scm = fakeScm({ getPullRequest: async () => ARMED });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('disabled');
    expect(scm.calls).toContain('disableAutoMerge');
    expect(scm.calls).not.toContain('enableAutoMerge');
    expect(m.updateMany).toHaveBeenCalled();
    expect(JSON.stringify(m.update.mock.calls)).toContain('auto-disarmed-by-platform');
  });

  it('disables an arming GitHub shows when the repository is not in auto mode, with no database row', async () => {
    m.previous.mockResolvedValue(null);
    const scm = fakeScm({ getPullRequest: async () => ARMED });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('disabled');
    expect(scm.calls).toContain('disableAutoMerge');
  });

  it('leaves GitHub alone when nothing is armed, even if an old row says it was', async () => {
    m.previous.mockResolvedValue({ autoMergeEnabled: true, headSha: HEAD, id: 'old' });
    const scm = fakeScm();
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.autoMerge).toBe('not-eligible');
    expect(scm.calls).not.toContain('disableAutoMerge');
  });

  it('throws a retryable error when the disarm is refused and GitHub still shows it armed', async () => {
    const scm = fakeScm({
      disableAutoMerge: async () => ({ ok: false, reason: 'refused' }),
      getPullRequest: async () => ARMED,
    });
    const err = await evaluatePullRequestWith(INPUT, depsWith(scm)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(false);
  });

  it('treats a refused disarm as done when GitHub no longer shows auto-merge', async () => {
    const states = [ARMED, ARMED, OPEN_PR];
    const scm = fakeScm({
      disableAutoMerge: async () => ({ ok: false, reason: 'not enabled' }),
      getPullRequest: async () => states.shift() ?? OPEN_PR,
    });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).autoMerge).toBe('disabled');
  });

  it('re-pins an arming made for another head: disable, then enable for this head', async () => {
    await autoRepo();
    m.previous.mockResolvedValue({ autoMergeEnabled: true, headSha: OLD_HEAD, id: 'old' });
    const scm = fakeScm({ getPullRequest: async () => ARMED });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).autoMerge).toBe('enabled');
    expect(scm.calls.indexOf('disableAutoMerge')).toBeLessThan(
      scm.calls.indexOf('enableAutoMerge')
    );
  });

  it('leaves an arming for the same head alone', async () => {
    await autoRepo();
    m.previous.mockResolvedValue({ autoMergeEnabled: true, headSha: HEAD, id: 'old' });
    const same = fakeScm({ getPullRequest: async () => ARMED });
    expect((await evaluatePullRequestWith(INPUT, depsWith(same))).autoMerge).toBe('unchanged');
    expect(same.calls).not.toContain('enableAutoMerge');
    expect(same.calls).not.toContain('disableAutoMerge');
  });

  it('cancels the arming when the host refuses the re-arm of an armed pull request', async () => {
    await autoRepo();
    m.previous.mockResolvedValue({ autoMergeEnabled: true, headSha: OLD_HEAD, id: 'old' });
    const scm = fakeScm({
      enableAutoMerge: async () => ({ ok: false, reason: 'refused' }),
      getPullRequest: async () => ARMED,
    });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).autoMerge).toBe('disabled');
    expect(scm.calls).toContain('disableAutoMerge');
  });

  it('records the disarm when a re-arm is refused after the old arming was cancelled', async () => {
    await autoRepo();
    m.previous.mockResolvedValue({ autoMergeEnabled: true, headSha: OLD_HEAD, id: 'old' });
    const scm = fakeScm({
      enableAutoMerge: async () => ({ ok: false, reason: 'refused' }),
      getPullRequest: async () => ARMED,
    });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(JSON.stringify(m.update.mock.calls)).toContain('auto-disarmed-by-platform');
    expect(m.updateMany).toHaveBeenCalled();
  });

  it('records the disarm when an arming could not be recorded and was rolled back', async () => {
    await autoRepo();
    m.update.mockRejectedValueOnce(new Error('db down'));
    const scm = fakeScm();
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).autoMerge).toBe('disabled');
    expect(scm.calls).toContain('disableAutoMerge');
    expect(JSON.stringify(m.update.mock.calls)).toContain('auto-disarmed-by-platform');
  });

  it('takes back an arming it could not record', async () => {
    await autoRepo();
    m.update.mockRejectedValue(new Error('db down'));
    const scm = fakeScm();
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).autoMerge).toBe('disabled');
    expect(scm.calls).toContain('disableAutoMerge');
  });

  it('does not swallow a failed rollback of an arming it could not record', async () => {
    await autoRepo();
    m.update.mockRejectedValue(new Error('db down'));
    const states = [OPEN_PR, OPEN_PR];
    const scm = fakeScm({
      disableAutoMerge: async () => ({ ok: false, reason: 'refused' }),
      getPullRequest: async () => states.shift() ?? ARMED,
    });
    await expect(evaluatePullRequestWith(INPUT, depsWith(scm))).rejects.toBeInstanceOf(
      ApplicationFailure
    );
  });

  it('calls nothing merge-like except enableAutoMerge', async () => {
    await autoRepo();
    const scm = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(scm.calls.filter((c) => /merge/i.test(c))).toEqual(['enableAutoMerge']);
  });
});

describe('evaluatePullRequest: disarming when evaluation is off', () => {
  it.each([
    [
      'the feature is switched off',
      () => {
        m.settings['prEvaluation.enabled'] = false;
      },
    ],
    [
      'the repository mode is off',
      () => {
        m.settings['prEvaluation.defaultMode'] = 'off';
      },
    ],
  ] as [string, () => void][])(
    'disarms a GitHub arming the platform made when %s',
    async (_n, arrange) => {
      arrange();
      m.previous.mockResolvedValue({
        autoMergeEnabled: true,
        headSha: HEAD,
        id: 'row-old',
        reasons: [],
      });
      const getPr = vi.fn(async () => ARMED);
      const scm = fakeScm({ getPullRequest: getPr });
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(result.outcome).toBe('skipped');
      expect(getPr).toHaveBeenCalledTimes(1);
      expect(scm.calls).toEqual(['disableAutoMerge']);
      expect(m.created).toHaveLength(0);
      expect(JSON.stringify(m.update.mock.calls)).toContain('auto-disarmed-by-platform');
    }
  );

  it('makes no SCM call when no earlier row was armed, or GitHub shows nothing armed', async () => {
    m.settings['prEvaluation.enabled'] = false;
    const none = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(none));
    expect(none.calls).toEqual([]);

    m.previous.mockResolvedValue({
      autoMergeEnabled: true,
      headSha: HEAD,
      id: 'row-old',
      reasons: [],
    });
    const clear = fakeScm();
    expect((await evaluatePullRequestWith(INPUT, depsWith(clear))).outcome).toBe('skipped');
    expect(clear.calls).toEqual(['getPullRequest']);
  });

  it('retries when the disarm fails', async () => {
    m.settings['prEvaluation.enabled'] = false;
    m.previous.mockResolvedValue({
      autoMergeEnabled: true,
      headSha: HEAD,
      id: 'row-old',
      reasons: [],
    });
    const scm = fakeScm({
      disableAutoMerge: async () => ({ ok: false, reason: 'x' }),
      getPullRequest: async () => ARMED,
    });
    await expect(evaluatePullRequestWith(INPUT, depsWith(scm))).rejects.toBeInstanceOf(
      ApplicationFailure
    );
  });
});

describe('evaluatePullRequest: the kill-switch sweep reads fresh settings', () => {
  const armedRow = { autoMergeEnabled: true, headSha: HEAD, id: 'row-old', reasons: [] };

  it('drops the per-process settings cache before resolving, so a disarm-sweep sees the write', async () => {
    // The worker's cache still says "enabled"; the database (read after invalidation) says off.
    m.onInvalidate = () => {
      m.settings['prEvaluation.enabled'] = false;
    };
    m.previous.mockResolvedValue(armedRow);
    const scm = fakeScm({ getPullRequest: async () => ARMED });
    const result = await evaluatePullRequestWith(
      { ...INPUT, trigger: 'disarm-sweep' },
      depsWith(scm)
    );
    expect(m.invalidated.count).toBe(1);
    expect(result).toMatchObject({ autoMerge: 'disabled', outcome: 'skipped' });
    expect(scm.calls).toContain('disableAutoMerge');
  });

  it('does not invalidate the cache for an ordinary trigger', async () => {
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(m.invalidated.count).toBe(0);
  });
});

describe('evaluatePullRequest: a human decision is not overridden', () => {
  const autoRepo = async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
  };
  const marker = (code: string) => [{ reasons: [{ code, message: 'm', severity: 'info' }] }];

  it.each([
    ['auto-armed', false],
    ['auto-suppressed-human', false],
    ['auto-disarmed-by-platform', true],
  ] as const)(
    'with the latest marker %s and auto-merge off on GitHub, arming is allowed: %s',
    async (code, allowed) => {
      await autoRepo();
      m.markers.mockResolvedValue(marker(code));
      const scm = fakeScm();
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(scm.calls.includes('enableAutoMerge')).toBe(allowed);
      if (!allowed) {
        expect(result.autoMerge).toBe('not-eligible');
        expect(JSON.stringify(m.created[0]?.reasons)).toContain('auto-suppressed-human');
      }
    }
  );

  it('arms when there is no marker', async () => {
    await autoRepo();
    const scm = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(scm.calls).toContain('enableAutoMerge');
  });

  describe('the marker scan reaches past 50 rows', () => {
    const nonMarkerRows = (n: number) =>
      Array.from({ length: n }, () => ({
        reasons: [{ code: 'x', message: 'm', severity: 'info' }],
      }));
    const paged = (rows: unknown[]) => async (args: { skip?: number; take: number }) =>
      rows.slice(args.skip ?? 0, (args.skip ?? 0) + args.take);

    it('finds an auto-armed marker 120 rows back and does not re-arm', async () => {
      await autoRepo();
      const rows = [...nonMarkerRows(120), ...marker('auto-armed'), ...nonMarkerRows(100)];
      m.markers.mockImplementation(paged(rows));
      const scm = fakeScm();
      const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(scm.calls).not.toContain('enableAutoMerge');
      expect(result.autoMerge).toBe('not-eligible');
    });

    it('treats a PR as suppressed when the cap is reached with no marker but an armed row exists', async () => {
      await autoRepo();
      m.previous.mockResolvedValue({
        autoMergeEnabled: true,
        headSha: OLD_HEAD,
        id: 'old',
        reasons: [],
      });
      m.markers.mockImplementation(paged(nonMarkerRows(600)));
      const scm = fakeScm();
      await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(scm.calls).not.toContain('enableAutoMerge');
      expect(JSON.stringify(m.created[0]?.reasons)).toContain('auto-suppressed-human');
    });

    it('still arms when the cap is reached with no marker and no row was ever armed', async () => {
      await autoRepo();
      m.markers.mockImplementation(paged(nonMarkerRows(600)));
      const scm = fakeScm();
      await evaluatePullRequestWith(INPUT, depsWith(scm));
      expect(scm.calls).toContain('enableAutoMerge');
    });
  });

  it('takes the newest marker row, not an older one', async () => {
    await autoRepo();
    m.markers.mockResolvedValue([...marker('auto-disarmed-by-platform'), ...marker('auto-armed')]);
    const scm = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(scm.calls).toContain('enableAutoMerge');
  });
});

describe('evaluatePullRequest: races', () => {
  it('returns superseded and publishes nothing when the head moved during the evaluation', async () => {
    const states = [OPEN_PR, { ...OPEN_PR, headSha: OLD_HEAD }];
    const scm = fakeScm({ getPullRequest: async () => states.shift() ?? OPEN_PR });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.outcome).toBe('superseded');
    expect(scm.calls).not.toContain('setCommitStatus');
    expect(scm.calls).not.toContain('upsertMarkedComment');
    expect(scm.calls).not.toContain('enableAutoMerge');
    expect(m.created).toHaveLength(0);
  });

  it('recomputes the approvals from a fresh review list taken just before publishing', async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
    let rulesRead = false;
    const scm = fakeScm({
      listPullRequestReviews: async () =>
        rulesRead ? [{ commitId: HEAD, login: 'bob', state: 'APPROVED', submittedAt: null }] : [],
      readBranchRules: async () => {
        rulesRead = true;
        return ALLOWS;
      },
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('success');
  });
});

describe('evaluatePullRequest: cheap checks first', () => {
  it('does not call the host for a pull request the platform did not open', async () => {
    m.platformPr.mockResolvedValue(null);
    const scm = fakeScm();
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(scm.calls).toEqual([]);
  });
});

describe('evaluatePullRequest: failures', () => {
  it('keeps the persisted row when publishing fails', async () => {
    const scm = fakeScm({
      setCommitStatus: async () => {
        throw new Error(`status failed ${SECRET}`);
      },
      upsertMarkedComment: async () => {
        throw new Error(`comment failed ${SECRET}`);
      },
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.outcome).toBe('evaluated');
    expect(m.created).toHaveLength(1);
    expect(m.logs.length).toBeGreaterThan(0);
  });

  it('records a HIGH row, sets a failure status and returns error on an unexpected error', async () => {
    const scm = fakeScm({
      listPullRequestFiles: async () => {
        throw new TypeError(`bad ${SECRET}`);
      },
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result).toMatchObject({ outcome: 'error', riskClass: 'HIGH', statusState: 'failure' });
    expect(m.created[0]).toMatchObject({
      requiredApprovers: 2,
      riskClass: 'HIGH',
      statusState: 'failure',
    });
    expect(JSON.stringify(m.created[0]?.reasons)).toContain('evaluation-error');
    const [, sha, status] = argsOf('setCommitStatus')[0] as [unknown, string, { state: string }];
    expect(sha).toBe(HEAD);
    expect(status.state).toBe('failure');
    expect(result.reason).not.toContain(SECRET);
    expect(JSON.stringify(m.created)).not.toContain(SECRET);
  });

  it('cancels the arming GitHub shows when evaluation fails', async () => {
    const scm = fakeScm({
      getPullRequest: async () => ARMED,
      listPullRequestFiles: async () => {
        throw new TypeError('bad');
      },
    });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(scm.calls).toContain('disableAutoMerge');
  });

  it('still reports the failure when its own bookkeeping fails', async () => {
    const scm = fakeScm({
      listPullRequestFiles: async () => {
        throw new TypeError('bad');
      },
      setCommitStatus: async () => {
        throw new Error('status down');
      },
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.outcome).toBe('error');
  });

  it('rethrows an error Temporal should retry, without writing a row', async () => {
    const scm = fakeScm({
      listPullRequestFiles: async () => {
        throw Object.assign(new Error('bad gateway'), { status: 502 });
      },
    });
    await expect(evaluatePullRequestWith(INPUT, depsWith(scm))).rejects.toThrow('bad gateway');
    expect(m.created).toHaveLength(0);
    expect(scm.calls).not.toContain('setCommitStatus');
  });

  it('rethrows a retryable error reading the pull request', async () => {
    const scm = fakeScm({
      getPullRequest: async () => {
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      },
    });
    await expect(evaluatePullRequestWith(INPUT, depsWith(scm))).rejects.toThrow('reset');
  });

  it('never logs a patch, a token or the policy text', async () => {
    const scm = fakeScm({
      fetchFileContent: async () => POLICY_TEXT,
      listPullRequestReviews: async () => {
        throw new Error(`leak ${SECRET} ${PATCH_TEXT} ${POLICY_TEXT}`);
      },
      setCommitStatus: async () => {
        throw new Error(`leak ${SECRET}`);
      },
    });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    const logged = JSON.stringify(m.logs) + JSON.stringify(m.created);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATCH_TEXT);
    expect(logged).not.toContain('policy-secret');
  });
});

describe('isRetryableEvaluationError', () => {
  it.each([
    [{ status: 500 }, true],
    [{ status: 503 }, true],
    [{ status: 429 }, true],
    [{ message: 'API rate limit exceeded', status: 403 }, true],
    [{ status: 403 }, false],
    [{ status: 404 }, false],
    [{ status: 422 }, false],
    [{ code: 'ETIMEDOUT' }, true],
    [{ code: 'P1001' }, true],
    [{ code: 'P2002' }, false],
    [new TypeError('x'), false],
    ['text', false],
  ])('%j -> %s', (err, expected) => {
    expect(isRetryableEvaluationError(err)).toBe(expected);
  });
});

describe('evaluatePullRequest: the run launcher cannot approve their own pull request', () => {
  const approval = (login: string, userId?: string): PullRequestReviewSummary => ({
    commitId: HEAD,
    login,
    state: 'APPROVED',
    submittedAt: null,
    ...(userId ? { userId } : {}),
  });
  const autoRepo = async () => {
    m.connection.mockResolvedValue({ ...(await m.connection()), prEvaluationMode: 'auto' });
  };
  const codes = () =>
    (m.created[0]?.reasons as { code: string }[] | undefined)?.map((r) => r.code) ?? [];

  it('does not count the launcher approval (by id), so the status stays pending', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval('renamed-since', LAUNCHER_ID)],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
    expect(codes()).toContain('launcher-excluded');
    // The launcher is never asked about, so no permission lookup is spent on them.
    expect(argsOf('repoPermission')).toHaveLength(0);
  });

  it('does not count the launcher approval (by login, any case) when the review carries no id', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval(LAUNCHER_LOGIN.toUpperCase())],
    });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).statusState).toBe('pending');
  });

  it('counts another trusted human next to the launcher', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [
        approval(LAUNCHER_LOGIN, LAUNCHER_ID),
        approval('bob', '7'),
      ],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('success');
    expect(result.autoMerge).toBe('enabled');
    expect(codes()).toContain('launcher-excluded');
  });

  it('records no launcher-excluded reason when the launcher did not approve', async () => {
    await autoRepo();
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    expect(codes()).not.toContain('launcher-excluded');
    expect(codes()).not.toContain('launcher-unresolved');
  });

  it.each([
    [
      'a run of the work has no launcher',
      () =>
        m.runs.mockImplementation(async () => [{ launchedById: 'user-1' }, { launchedById: null }]),
    ],
    [
      'the work request has no person behind it',
      () =>
        m.request.mockImplementation(async () => ({
          requestedById: null,
          requestedByServiceId: 'svc-1',
        })),
    ],
    [
      'there is no run, workflow or work request to follow',
      () => {
        m.platformPr.mockResolvedValue({
          runId: null,
          workflow: { temporalWorkflowId: '', workRequestId: null },
        });
      },
    ],
    [
      'the launcher never linked GitHub',
      () => {
        m.users = { 'user-1': { githubLogin: null, githubLoginAccountId: null } };
      },
    ],
    [
      'the launcher is linked by login only (no numeric account id)',
      () => {
        m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: null } };
      },
    ],
    [
      'the launcher user row is gone',
      () => {
        m.users = {};
      },
    ],
    [
      'the launcher account is on another host than the repository',
      () => {
        m.repoHost.value = 'ghe.example.com';
      },
    ],
  ])('keeps counting approvals but never arms when %s', async (_name, arrange) => {
    await autoRepo();
    arrange();
    const scm = fakeScm();
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('success');
    expect(result.autoMerge).not.toBe('enabled');
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(codes()).toContain('launcher-unresolved');
    const reasons = (m.created[0]?.reasons ?? []) as { code: string; message: string }[];
    const blocked = reasons.find((r) => r.code === 'auto-merge-blocked');
    expect(blocked?.message).toMatch(/launched or requested/);
  });

  it('still excludes the members that resolved when another run has no launcher', async () => {
    await autoRepo();
    m.runs.mockImplementation(async () => [{ launchedById: null }, { launchedById: 'user-1' }]);
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval('renamed-since', LAUNCHER_ID)],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
    expect(codes()).toContain('launcher-excluded');
    expect(codes()).toContain('launcher-unresolved');
  });

  it('excludes the original launcher after a re-run by someone else took the stamp over', async () => {
    await autoRepo();
    // The stamped run is Y's; X launched the original run of the same work; Z asked for it.
    m.platformPr.mockResolvedValue({
      runId: 'run-y',
      workflow: {
        temporalWorkflowId: 'eng-acme-widgets-JIRA-1-rerun',
        workRequestId: WORK_REQUEST,
      },
    });
    m.runs.mockImplementation(async (args: { where: { OR: unknown[] } }) => {
      expect(args.where.OR).toEqual([
        { id: 'run-y' },
        { workflowId: 'eng-acme-widgets-JIRA-1-rerun' },
        { OR: [{ connectionId: null }, { connectionId: CONNECTION }], workRequestId: WORK_REQUEST },
      ]);
      return [{ launchedById: 'user-y' }, { launchedById: 'user-1' }];
    });
    m.request.mockImplementation(async () => ({
      requestedById: 'user-z',
      requestedByServiceId: null,
    }));
    m.users = {
      'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: LAUNCHER_ID },
      'user-y': { githubLogin: 'rerunner', githubLoginAccountId: '2' },
      'user-z': { githubLogin: 'requester', githubLoginAccountId: '3' },
    };
    const scm = fakeScm({
      listPullRequestReviews: async () => [
        approval('anything', LAUNCHER_ID),
        approval('rerunner', '2'),
        approval('requester', '3'),
      ],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('pending');
    expect(m.created[0]?.reasons).toContainEqual(
      expect.objectContaining({
        code: 'launcher-excluded',
        message: expect.stringContaining('3 distinct approver(s)'),
      })
    );
    expect(codes()).not.toContain('launcher-unresolved');
    expect(argsOf('repoPermission')).toHaveLength(0);
  });

  it('a retry by Y after X still excludes X (both runs of the same work)', async () => {
    await autoRepo();
    m.runs.mockImplementation(async () => [{ launchedById: 'user-y' }, { launchedById: 'user-1' }]);
    m.users['user-y'] = { githubLogin: 'retrier', githubLoginAccountId: '2' };
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval('x-now', LAUNCHER_ID), approval('bob', '7')],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    expect(result.statusState).toBe('success');
    expect(argsOf('repoPermission').map((a) => a[1])).toEqual(['bob']);
  });

  it('does not exclude a reviewer who renamed away when the launcher is linked by login only, and never arms', async () => {
    await autoRepo();
    m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: null } };
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval('brand-new-login', LAUNCHER_ID)],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    // Nothing links the new login to the launcher, so the approval counts: arming is the guard.
    expect(result.statusState).toBe('success');
    expect(result.autoMerge).not.toBe('enabled');
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(codes()).toContain('launcher-unresolved');
  });

  it('still excludes a login-only launcher by login', async () => {
    await autoRepo();
    m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: null } };
    const scm = fakeScm({ listPullRequestReviews: async () => [approval(LAUNCHER_LOGIN)] });
    expect((await evaluatePullRequestWith(INPUT, depsWith(scm))).statusState).toBe('pending');
  });

  it('does not exclude by id on a repository host other than the account host', async () => {
    await autoRepo();
    m.repoHost.value = 'ghe.example.com';
    const scm = fakeScm({
      listPullRequestReviews: async () => [approval('someone-else', LAUNCHER_ID)],
    });
    const result = await evaluatePullRequestWith(INPUT, depsWith(scm));
    // The same number on another host is another person: counted, and arming is refused.
    expect(result.statusState).toBe('success');
    expect(result.autoMerge).not.toBe('enabled');
  });

  it('arms when the launcher is resolved and every other condition holds', async () => {
    await autoRepo();
    expect((await evaluatePullRequestWith(INPUT, depsWith(fakeScm()))).autoMerge).toBe('enabled');
  });

  it('never puts the launcher login or id in a comment, status, row or log', async () => {
    await autoRepo();
    const scm = fakeScm({
      listPullRequestReviews: async () => [
        approval(LAUNCHER_LOGIN, LAUNCHER_ID),
        approval('bob', '7'),
      ],
    });
    await evaluatePullRequestWith(INPUT, depsWith(scm));
    m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: null } };
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    m.runs.mockImplementation(async () => [{ launchedById: null }, { launchedById: 'user-1' }]);
    await evaluatePullRequestWith(INPUT, depsWith(fakeScm()));
    const everything = JSON.stringify([m.calls, m.created, m.update.mock.calls, m.logs]);
    expect(everything).not.toContain(LAUNCHER_LOGIN);
    expect(everything).not.toContain(LAUNCHER_ID);
  });
});

describe('evaluatePullRequest: bot approval', () => {
  const BOT_LOGIN = 'approver-app[bot]';
  const BOT_SLUG = 'approver-app';
  const BOT_REVIEW_ID = '901';
  const OLD_REVIEW_ID = '902';
  const NEW_REVIEW_ID = '777';
  const APP_TOKEN = 'ghs_approverInstallationToken';
  const STATUS_CONTEXT = 'auto-swe/pr-evaluation';
  const WITHDRAW_MESSAGE =
    'The auto-swe evaluator withdrew its approval: the conditions for approving no longer hold.';
  const EXPECTED_BODY = `Approved by the auto-swe evaluator: LOW risk, all conditions met. This approval is bound to commit ${HEAD.slice(0, 8)}.`;
  const SUCCESS_STATUS = {
    context: STATUS_CONTEXT,
    description: 'LOW risk: approved by the evaluator, no human approval required',
    state: 'success',
  };
  const PENDING_STATUS = {
    context: STATUS_CONTEXT,
    description: 'LOW risk: waiting for 0/1 approvals',
    state: 'pending',
  };

  type World = {
    reviews: PullRequestReviewSummary[];
    config: { appSlug: string } | null;
    /** What the approver's slugs say; absent means the activity falls back to `config`. */
    slugs?: { active: string | null; retired: string[] };
    clientResult: 'ok' | { ok: false; reason: ApproverClientFailure };
    submitResult: { ok: true; reviewId: string } | { ok: false; reason: string } | 'throw';
    submitAdds: boolean;
    dismissResult: { ok: boolean; reason?: string } | 'throw';
    botRow: { headSha: string; id: string; reasons: unknown; botApproved: true } | null;
    statusOk: boolean;
  };
  let world: World;
  let client: ApproverSession;
  let submit: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let getClient: ReturnType<typeof vi.fn>;
  let loadConfig: ReturnType<typeof vi.fn>;

  const botApproval = (id = BOT_REVIEW_ID, commitId = HEAD): PullRequestReviewSummary => ({
    commitId,
    id,
    login: BOT_LOGIN,
    state: 'APPROVED',
    submittedAt: null,
  });
  const dismissedOwn = (commitId: string, id = '905'): PullRequestReviewSummary => ({
    commitId,
    id,
    login: BOT_LOGIN,
    state: 'DISMISSED',
    submittedAt: null,
  });
  const human = (): PullRequestReviewSummary => ({
    commitId: HEAD,
    login: 'bob',
    state: 'APPROVED',
    submittedAt: null,
  });

  const CONNECTION_ROW = {
    githubApiUrl: null,
    githubUrl: null,
    id: CONNECTION,
    installation: null,
    isActive: true,
    organizationName: 'acme',
    prEvaluationBotApproval: true,
    prEvaluationMode: 'auto',
    repoName: 'widgets',
    team: { orgId: 'org-1' },
    teamId: 'team-1',
  };

  beforeEach(async () => {
    release = vi.fn(async () => undefined);
    client = {
      release: release as unknown as ApproverSession['release'],
      request: vi.fn(async () => ({ data: { token: APP_TOKEN } })),
    };
    world = {
      botRow: null,
      clientResult: 'ok',
      config: { appSlug: BOT_SLUG },
      dismissResult: { ok: true },
      reviews: [],
      statusOk: true,
      submitAdds: true,
      submitResult: { ok: true, reviewId: NEW_REVIEW_ID },
    };
    submit = vi.fn(async (_c: unknown, _r: unknown, _n: number, input: { headSha: string }) => {
      m.calls.push({ args: [], name: 'submit' });
      if (world.submitResult === 'throw') {
        throw new Error(`submit failed ${APP_TOKEN}`);
      }
      if (world.submitResult.ok && world.submitAdds) {
        world.reviews.push(botApproval(NEW_REVIEW_ID, input.headSha));
      }
      return world.submitResult;
    });
    getClient = vi.fn(async () =>
      world.clientResult === 'ok' ? { client, ok: true } : world.clientResult
    );
    loadConfig = vi.fn(async () => world.config);
    m.settings['prEvaluation.botApprovalAllowed'] = true;
    // The shared fixtures change `src/` files, so the allowlist here adds that directory.
    m.settings['prEvaluation.botApprovalPaths'] = ['src/**', ...DEFAULT_BOT_APPROVAL_PATHS];
    m.connection.mockResolvedValue(CONNECTION_ROW);
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? world.botRow : null
    );
  });

  // The branch needs no review of its own, so only the evaluation status stands between a pull
  // request and a merge: arming then depends on the approval count, which is what is under test.
  const BOT_RULES: BranchRules = {
    ...ALLOWS,
    dismissStaleReviews: true,
    requiredReviewCount: 0,
    requiresReviews: false,
  };

  function scmWith(over: Partial<Record<keyof ScmProvider, unknown>> = {}): Fake {
    return fakeScm({
      dismissReview: async (...args: unknown[]) => {
        m.calls.push({ args, name: 'dismissReview' });
        if (world.dismissResult === 'throw') {
          throw new Error(`dismiss failed ${APP_TOKEN}`);
        }
        return world.dismissResult;
      },
      listPullRequestReviews: async () => [...world.reviews],
      readBranchRules: async () => BOT_RULES,
      setCommitStatus: async (...args: unknown[]) => {
        m.calls.push({ args, name: 'setCommitStatus' });
        return world.statusOk ? { ok: true } : { ok: false, reason: 'nope' };
      },
      ...over,
    });
  }

  function botDeps(scm: Fake): EvaluatePullRequestDeps {
    return {
      ...depsWith(scm),
      approver: {
        getClient,
        loadBotSlugs: world.slugs ? async () => world.slugs : undefined,
        loadConfig,
        submit,
      } as never,
    };
  }

  /** The calls that decide whether a merge can happen, in order, each status by its state. */
  const gateOrder = () =>
    m.calls
      .map((c) =>
        c.name === 'setCommitStatus' ? `status:${(c.args[2] as { state: string }).state}` : c.name
      )
      .filter((n) => n === 'dismissReview' || n === 'disableAutoMerge' || n.startsWith('status:'));
  const INTERIM_STATUS = {
    context: STATUS_CONTEXT,
    description: 'Evaluation changed: waiting',
    state: 'pending',
  };

  const statuses = () => argsOf('setCommitStatus').map((a) => a[2]);
  const stateOf = (st: unknown) => (st as { state: string }).state;
  const dismissed = () => argsOf('dismissReview').map((a) => a[2]);
  const order = () => m.calls.map((c) => c.name);
  const lastRow = () => m.created.at(-1) as Record<string, unknown>;
  const rowReasons = () => lastRow().reasons as { code: string; message: string }[];
  const rowCodes = () => rowReasons().map((r) => r.code);

  /**
   * Every scenario changes exactly one input, and the refusal the row records must name exactly the
   * conditions that input breaks: a condition deleted from the evaluator changes the message.
   */
  const SCENARIOS: Record<BotApprovalCondition, () => Fake> = {
    'allows-auto-merge': () =>
      scmWith({ readBranchRules: async () => ({ ...BOT_RULES, allowsAutoMerge: false }) }),
    'approver-app-configured': () => {
      world.config = null;
      return scmWith();
    },
    'approver-client-ok': () => {
      world.clientResult = { ok: false, reason: 'not-installed' };
      return scmWith();
    },
    'author-differs': () =>
      scmWith({ getPullRequest: async () => ({ ...OPEN_PR, author: 'Approver-App[bot]' }) }),
    // Risk is LOW only without an exclusion, and an exclusion is what makes a change ineligible:
    // these three cannot be flipped on their own, so each is checked with its companions.
    'auto-eligible': () => policyChanged(),
    'auto-merge-allowed': () => {
      m.settings['prEvaluation.autoMergeAllowed'] = false;
      return scmWith();
    },
    'bot-approval-allowed': () => {
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      return scmWith();
    },
    'bot-max-files': () =>
      scmWith({
        listPullRequestFiles: async () => ({
          files: [
            ...lowFiles(),
            {
              additions: 1,
              deletions: 0,
              patch: '@@ -1 +1 @@\n+a',
              path: 'src/b.ts',
              status: 'modified',
            },
            {
              additions: 1,
              deletions: 0,
              patch: '@@ -1 +1 @@\n+a',
              path: 'src/c.ts',
              status: 'modified',
            },
          ],
          truncated: false,
        }),
      }),
    'bot-max-lines': () =>
      scmWith({
        listPullRequestFiles: async () => ({
          files: [{ ...lowFiles()[0], additions: 40, deletions: 11 }, lowFiles()[1]],
          truncated: false,
        }),
      }),
    'bot-paths-allowed': () =>
      scmWith({
        listPullRequestFiles: async () => ({
          files: [{ ...lowFiles()[0], path: 'app/main.ts' }, lowFiles()[1]],
          truncated: false,
        }),
      }),
    'dismiss-stale-reviews': () =>
      scmWith({ readBranchRules: async () => ({ ...BOT_RULES, dismissStaleReviews: false }) }),
    'effective-mode-auto': () => {
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationMode: 'enforce' });
      return scmWith();
    },
    'evidence-satisfied': () => {
      m.evidence.repoLow = 0;
      return scmWith();
    },
    'head-sha': () => {
      // The reviewers' verdict is recorded for this (blank) head, so risk stays LOW.
      m.steps.mockResolvedValue([
        { outputs: { codeResult: { headSha: '' }, verdicts: [{ severity: 'PASS' }] } },
      ]);
      return scmWith({ getPullRequest: async () => ({ ...OPEN_PR, headSha: '' }) });
    },
    'launcher-resolved': () => {
      m.users = { 'user-1': { githubLogin: LAUNCHER_LOGIN, githubLoginAccountId: null } };
      return scmWith();
    },
    'no-exclusions': () => policyChanged(),
    'no-human-objection': () => {
      world.reviews = [
        ...world.reviews,
        {
          commitId: OLD_HEAD,
          login: 'zed-objector',
          state: 'CHANGES_REQUESTED',
          submittedAt: null,
        },
      ];
      return scmWith();
    },
    'no-net-test-deletion': () =>
      scmWith({
        listPullRequestFiles: async () => ({
          files: [lowFiles()[0], { ...lowFiles()[1], additions: 1, deletions: 3 }],
          truncated: false,
        }),
      }),
    'no-stricter-approver-count': () => {
      m.settings['prEvaluation.lowApprovers'] = 2;
      return scmWith();
    },
    'not-draft': () => scmWith({ getPullRequest: async () => ({ ...OPEN_PR, draft: true }) }),
    'not-suppressed': () => {
      world.reviews = [dismissedOwn(HEAD), ...world.reviews];
      return scmWith();
    },
    'repo-bot-approval': () => {
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationBotApproval: false });
      return scmWith();
    },
    'risk-low': () =>
      scmWith({
        listPullRequestFiles: async () => ({
          files: [{ ...lowFiles()[0], additions: 900, deletions: 0 }],
          truncated: false,
        }),
      }),
    'status-pinned': () =>
      scmWith({
        readBranchRules: async () => ({ ...BOT_RULES, requiredStatusPinnedToApp: false }),
      }),
    'status-required': () =>
      scmWith({ readBranchRules: async () => ({ ...BOT_RULES, requiredStatusContexts: [] }) }),
  };
  // What else the one changed input breaks: a deployment that forbids auto-merge also downgrades
  // the effective mode; no approver App means no bot login to differ from the author; a policy
  // change is an exclusion that makes the risk HIGH. Each condition alone is flipped in
  // `botApproval.test.ts`; here the exact set is pinned, so a deleted condition changes it.
  const BROKEN_TOGETHER: Partial<Record<BotApprovalCondition, BotApprovalCondition[]>> = {
    'approver-app-configured': ['approver-app-configured', 'author-differs'],
    // The policy file is outside the bot's allowlist as well.
    'auto-eligible': [
      'risk-low',
      'auto-eligible',
      'no-exclusions',
      'bot-paths-allowed',
      'no-stricter-approver-count',
    ],
    'auto-merge-allowed': ['effective-mode-auto', 'auto-merge-allowed'],
    'no-exclusions': [
      'risk-low',
      'auto-eligible',
      'no-exclusions',
      'bot-paths-allowed',
      'no-stricter-approver-count',
    ],
    // 900 changed lines is also over the bot's own cap.
    'risk-low': ['risk-low', 'auto-eligible', 'bot-max-lines'],
  };

  function policyChanged(): Fake {
    return scmWith({
      listPullRequestFiles: async () => ({
        files: [
          ...lowFiles(),
          {
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1 @@\n+a',
            path: '.auto-swe/pr-policy.yml',
            status: 'modified',
          },
        ],
        truncated: false,
      }),
    });
  }

  it('has a scenario for every condition', () => {
    expect(BOT_APPROVAL_CONDITIONS).toHaveLength(25);
    expect(Object.keys(SCENARIOS).sort()).toEqual([...BOT_APPROVAL_CONDITIONS].sort());
  });

  it.each(BOT_APPROVAL_CONDITIONS.map((c) => [c] as const))(
    'does not approve, arm or keep an approval standing when the condition %s fails, and records exactly that',
    async (condition) => {
      world.reviews = [botApproval()];
      const scm = SCENARIOS[condition]();
      const result = await evaluatePullRequestWith(INPUT, botDeps(scm));
      expect(result.outcome).toBe('evaluated');
      expect(submit).not.toHaveBeenCalled();
      if (condition !== 'approver-client-ok') {
        expect(getClient).not.toHaveBeenCalled();
      }
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
      expect(lastRow().botApproved).toBe(false);
      expect(lastRow().trustedApprovers).toBe(0);
      const conditions = BROKEN_TOGETHER[condition] ?? [condition];
      if (condition === 'approver-app-configured') {
        // Nothing can be told apart as the approver's own without its slug: nothing is withdrawn.
        expect(dismissed()).toEqual([]);
        expect(rowCodes()).toContain('bot-approval-credentials-missing');
      } else {
        expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      }
      expect(rowReasons().map((r) => r.message)).toContain(
        `Bot approval was not given: ${conditions.join(', ')}.`
      );
    }
  );

  it('submits one approving review bound to the head, then reports success, arms and revokes the token', async () => {
    const scm = scmWith();
    const result = await evaluatePullRequestWith(INPUT, botDeps(scm));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ organizationName: 'acme', repoName: 'widgets' }),
      7,
      { body: EXPECTED_BODY, headSha: HEAD }
    );
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(order().indexOf('submit')).toBeLessThan(order().indexOf('setCommitStatus'));
    expect(statuses()).toEqual([SUCCESS_STATUS]);
    expect(result).toMatchObject({ autoMerge: 'enabled', statusState: 'success' });
    expect(argsOf('enableAutoMerge')).toHaveLength(1);
    expect(dismissed()).toEqual([]);
    expect(lastRow()).toMatchObject({
      botApproved: true,
      statusState: 'success',
      trustedApprovers: 0,
    });
    expect(rowCodes()).toContain('bot-approval-posted');
    expect(lastRow().readiness).toMatchObject({
      botApproval: { eligible: true, state: 'approved' },
    });
    expect(JSON.stringify(argsOf('upsertMarkedComment'))).toContain(
      'Approved by the evaluator; no human approval was required.'
    );
  });

  it('revokes the token even when the submit throws', async () => {
    world.submitResult = 'throw';
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not submit twice when its approval already stands on the head', async () => {
    world.reviews = [botApproval()];
    const result = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).not.toHaveBeenCalled();
    expect(statuses()).toEqual([SUCCESS_STATUS]);
    expect(result.autoMerge).toBe('enabled');
    expect(lastRow()).toMatchObject({ botApproved: true });
    expect(rowCodes()).toContain('bot-approval-present');
    expect(rowCodes()).not.toContain('bot-approval-posted');
    expect(dismissed()).toEqual([]);
  });

  it('does not mistake an approval of an older head for one of this head', async () => {
    world.reviews = [botApproval(OLD_REVIEW_ID, OLD_HEAD)];
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(lastRow()).toMatchObject({ botApproved: true, statusState: 'success' });
  });

  it('does not count a bot approval as a trusted approver or ask about its permission', async () => {
    world.reviews = [botApproval()];
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(lastRow().trustedApprovers).toBe(0);
    expect(argsOf('repoPermission').map((a) => a[1])).not.toContain(BOT_LOGIN);
  });

  it('keeps counting only people when a human also approved', async () => {
    world.reviews = [botApproval(), human()];
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(lastRow().trustedApprovers).toBe(1);
  });

  it.each([
    ['refused', { ok: false, reason: 'refused' }],
    ['unprocessable', { ok: false, reason: 'unprocessable' }],
    ['not-found', { ok: false, reason: 'not-found' }],
  ] as const)('stays pending and arms nothing when the submit is %s', async (reason, result) => {
    world.submitResult = result;
    const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual([PENDING_STATUS]);
    expect(out.statusState).toBe('pending');
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(lastRow().botApproved).toBe(false);
    expect(rowCodes()).toContain(`bot-approval-refused:submit-${reason}`);
    expect(lastRow().readiness).toMatchObject({
      botApproval: { eligible: true, state: 'refused' },
    });
  });

  it('stays pending when the submit throws, and logs only the error name', async () => {
    world.submitResult = 'throw';
    const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(out).toMatchObject({ outcome: 'evaluated', statusState: 'pending' });
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(lastRow().botApproved).toBe(false);
    const logged = JSON.stringify(m.logs);
    expect(logged).toContain('"errorName":"Error"');
    expect(logged).not.toContain(APP_TOKEN);
  });

  it('does not trust a successful submit that the review list does not show', async () => {
    world.submitAdds = false;
    const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(out.statusState).toBe('pending');
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(lastRow().botApproved).toBe(false);
    expect(rowCodes()).toContain('bot-approval-refused:not-confirmed');
  });

  it('withdraws the approval it just made when the review list cannot be read after the submit', async () => {
    let afterSubmit = 0;
    const scm = scmWith({
      listPullRequestReviews: async () => {
        if (submit.mock.calls.length > 0 && afterSubmit++ === 0) {
          throw new Error('list failed');
        }
        return [...world.reviews];
      },
    });
    const out = await evaluatePullRequestWith(INPUT, botDeps(scm));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(out.statusState).not.toBe('success');
    expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
    expect(argsOf('enableAutoMerge')).toHaveLength(0);
    expect(dismissed()).toEqual([NEW_REVIEW_ID]);
    expect(lastRow().botApproved).toBe(false);
  });

  it('retracts an unrecorded approval and its status when a retryable error follows the publish', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.prEvaluation.create).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { status: 503 })
    );
    await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
      status: 503,
    });
    expect(stateOf(statuses().at(-1) as never)).toBe('pending');
    expect(dismissed()).toEqual([NEW_REVIEW_ID]);
    // A marker row says the platform made the dismissal, so the retry does not read it as a person's.
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({ headSha: HEAD, statusState: 'pending' });
    expect(rowCodes()).toEqual(['bot-approval-withdrawn']);
  });

  it('approves again on the retry after a retraction, instead of reading it as a person dismissal', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.prEvaluation.create).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { status: 503 })
    );
    await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
      status: 503,
    });
    const rows = m.created.map((r) => ({ headSha: r.headSha, reasons: r.reasons }));
    m.markers.mockResolvedValue(rows);
    world.reviews = [dismissedOwn(HEAD, NEW_REVIEW_ID)];
    submit.mockClear();
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(rowCodes()).not.toContain('bot-approval-suppressed');
  });

  it('still dismisses the approval when the status behind it cannot be reset', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    let failing = false;
    vi.mocked(prisma.prEvaluation.create).mockImplementationOnce((() => {
      failing = true;
      return Promise.reject(Object.assign(new Error('unavailable'), { status: 503 }));
    }) as never);
    const base = scmWith();
    const scm = {
      ...base,
      setCommitStatus: async (...a: Parameters<typeof base.setCommitStatus>) => {
        if (failing) {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }
        return base.setCommitStatus(...a);
      },
    } as typeof base;
    await expect(evaluatePullRequestWith(INPUT, botDeps(scm))).rejects.toMatchObject({
      status: 503,
    });
    expect(dismissed()).toEqual([NEW_REVIEW_ID]);
  });

  it('retracts a standing approval no row records when a later attempt fails', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    vi.mocked(prisma.prEvaluation.create).mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { status: 503 })
    );
    world.reviews = [botApproval(BOT_REVIEW_ID)];
    await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
      status: 503,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(dismissed()).toEqual([BOT_REVIEW_ID]);
  });

  it('retries the activity when the approval it made can be neither listed nor withdrawn', async () => {
    const scm = scmWith({
      listPullRequestReviews: async () => {
        if (submit.mock.calls.length > 0) {
          throw new Error('list failed');
        }
        return [...world.reviews];
      },
    });
    await expect(evaluatePullRequestWith(INPUT, botDeps(scm))).rejects.toMatchObject({
      type: 'BOT_APPROVAL_NOT_WITHDRAWN',
    });
  });

  it.each([
    'not-configured',
    'host-not-allowed',
    'host-mismatch',
    'same-app-as-platform',
    'not-installed',
    'installation-too-broad',
    'slug-mismatch',
    'key-invalid',
  ] as const)(
    'refuses without submitting when the approver client is unusable: %s',
    async (reason) => {
      world.clientResult = { ok: false, reason };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
      expect(rowCodes()).toContain(`bot-approval-refused:client-${reason}`);
      expect(lastRow().readiness).toMatchObject({
        botApproval: { eligible: false, state: 'refused' },
      });
    }
  );

  describe('a person who objects or dismisses is not overridden', () => {
    const OBJECTOR = 'zed-objector';
    const objection = (login = OBJECTOR): PullRequestReviewSummary => ({
      commitId: HEAD,
      id: '950',
      login,
      state: 'CHANGES_REQUESTED',
      submittedAt: null,
    });
    const pages = (rows: unknown[]) => async (a: { skip?: number; take: number }) =>
      rows.slice(a.skip ?? 0, (a.skip ?? 0) + a.take);
    const filler = (n: number) =>
      Array.from({ length: n }, () => ({
        headSha: HEAD,
        reasons: [{ code: 'x', message: 'm', severity: 'info' }],
      }));
    const withdrawnRow = (headSha = HEAD) => ({
      headSha,
      reasons: [{ code: 'bot-approval-withdrawn', message: 'm', severity: 'info' }],
    });

    it('does not approve over a standing request for changes, and says only the condition', async () => {
      world.reviews = [objection()];
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(rowReasons().map((r) => r.message)).toContain(
        'Bot approval was not given: no-human-objection.'
      );
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('approves once the objector approves instead', async () => {
      world.reviews = [objection(), { ...objection(), state: 'APPROVED' }];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('withdraws a standing bot approval when a human objects, and takes the status back to pending', async () => {
      world.reviews = [botApproval(), objection()];
      world.botRow = { botApproved: true, headSha: HEAD, id: 'row-old', reasons: [] };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out.statusState).toBe('pending');
      expect(statuses().map(stateOf)).toEqual(['pending']);
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(order().indexOf('setCommitStatus')).toBeLessThan(order().indexOf('dismissReview'));
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview']);
      expect(lastRow()).toMatchObject({ botApproved: false, statusState: 'pending' });
      expect(rowCodes()).toContain('bot-approval-withdrawn');
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('does not approve when a person dismissed its approval of this head, and records the suppression', async () => {
      world.reviews = [dismissedOwn(HEAD)];
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(rowCodes()).toContain('bot-approval-suppressed');
      expect(rowReasons().map((r) => r.message)).toContain(
        'Bot approval was not given: not-suppressed.'
      );
    });

    it('never approves a NEW head once a row recorded the suppression', async () => {
      // The dismissed review is of the earlier commit, as it is after a push; only the row says so.
      world.reviews = [dismissedOwn(OLD_HEAD)];
      m.markers.mockResolvedValue([
        ...filler(2),
        { headSha: OLD_HEAD, reasons: [{ code: 'bot-approval-suppressed', severity: 'info' }] },
      ]);
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(rowCodes()).toContain('bot-approval-suppressed');
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('does not take its own earlier withdrawal for a person, and approves again', async () => {
      world.reviews = [dismissedOwn(HEAD)];
      m.markers.mockResolvedValue([withdrawnRow()]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
      expect(rowCodes()).not.toContain('bot-approval-suppressed');
    });

    it('counts per dismissal: two dismissed reviews and one withdrawal is a person', async () => {
      world.reviews = [dismissedOwn(HEAD, '905'), dismissedOwn(HEAD, '906')];
      m.markers.mockResolvedValue([withdrawnRow()]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(rowCodes()).toContain('bot-approval-suppressed');
    });

    it('does not count a withdrawal recorded for another head against this one', async () => {
      world.reviews = [dismissedOwn(HEAD)];
      m.markers.mockResolvedValue([withdrawnRow(OLD_HEAD)]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(rowCodes()).toContain('bot-approval-suppressed');
    });

    it('does not take the host dismissing an approval of an earlier commit for a person', async () => {
      world.reviews = [dismissedOwn(OLD_HEAD)];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
      expect(rowCodes()).not.toContain('bot-approval-suppressed');
    });

    it('finds the suppression marker on a later page of the scan', async () => {
      const rows = [
        ...filler(250),
        { headSha: OLD_HEAD, reasons: [{ code: 'bot-approval-suppressed' }] },
      ];
      m.markers.mockImplementation(pages(rows));
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(rowCodes()).toContain('bot-approval-suppressed');
    });

    it('reads at most 500 rows, and when it cannot see the withdrawals it errs towards suppressed', async () => {
      world.reviews = [dismissedOwn(HEAD)];
      const rows = [...filler(600), withdrawnRow()];
      const reads = vi.fn(pages(rows));
      m.markers.mockImplementation(reads);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(reads).toHaveBeenCalledTimes(5);
      expect(submit).not.toHaveBeenCalled();
      expect(rowCodes()).toContain('bot-approval-suppressed');
    });

    it('approves when the cap is reached but no dismissal of its own is in doubt', async () => {
      m.markers.mockImplementation(pages(filler(600)));
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('records one withdrawal per review it dismisses, and tells an earlier commit apart', async () => {
      world.reviews = [botApproval(), botApproval(OLD_REVIEW_ID, OLD_HEAD)];
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([BOT_REVIEW_ID, OLD_REVIEW_ID]);
      expect(rowCodes().filter((c) => c === 'bot-approval-withdrawn')).toHaveLength(1);
      expect(rowCodes().filter((c) => c === 'bot-approval-withdrawn-older')).toHaveLength(1);
    });

    it('rereads the review list before counting: an objection that lands after the submit withdraws it', async () => {
      submit.mockImplementation(
        async (_c: unknown, _r: unknown, _n: number, i: { headSha: string }) => {
          world.reviews.push(botApproval(NEW_REVIEW_ID, i.headSha), objection());
          return { ok: true, reviewId: NEW_REVIEW_ID };
        }
      );
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out.statusState).toBe('pending');
      expect(lastRow().botApproved).toBe(false);
      expect(dismissed()).toEqual([NEW_REVIEW_ID]);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('writes no login, id or slug into any log, row, comment, status or dismissal message', async () => {
      world.reviews = [
        botApproval(),
        dismissedOwn(HEAD, '905'),
        objection(),
        { ...human(), login: 'carol-the-human' },
      ];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      world.reviews = [dismissedOwn(HEAD)];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      const everything = JSON.stringify([
        m.logs,
        m.created,
        m.update.mock.calls,
        argsOf('setCommitStatus'),
        argsOf('upsertMarkedComment'),
        argsOf('dismissReview').map((a) => a[3]),
      ]);
      for (const secret of [
        BOT_LOGIN,
        BOT_SLUG,
        OBJECTOR,
        'carol-the-human',
        APP_TOKEN,
        '"901"',
        '"905"',
        '"950"',
      ]) {
        expect(everything.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    });
  });

  describe('withdrawal goes through the platform credential', () => {
    it('dismisses the approval with the platform provider, mints no approver token, and never counts it', async () => {
      world.reviews = [botApproval()];
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(argsOf('dismissReview')).toEqual([
        [expect.objectContaining({ organizationName: 'acme' }), 7, BOT_REVIEW_ID, WITHDRAW_MESSAGE],
      ]);
      expect(getClient).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(statuses()).toEqual([PENDING_STATUS]);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
      expect(lastRow().botApproved).toBe(false);
      expect(rowCodes()).toContain('bot-approval-withdrawn');
      expect(lastRow().readiness).toMatchObject({
        botApproval: { eligible: false, state: 'withdrawn' },
      });
    });

    it('withdraws with the approver credentials gone: no approver client is needed', async () => {
      world.reviews = [botApproval()];
      world.clientResult = { ok: false, reason: 'not-installed' };
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(lastRow().botApproved).toBe(false);
    });

    it('withdraws EVERY standing approval, of any commit, and leaves a dismissed one alone', async () => {
      world.reviews = [
        botApproval(OLD_REVIEW_ID, OLD_HEAD),
        { ...botApproval('903', OLD_HEAD), state: 'DISMISSED' },
        botApproval(),
        human(),
      ];
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([OLD_REVIEW_ID, BOT_REVIEW_ID]);
      expect(lastRow().botApproved).toBe(false);
    });

    it('withdraws an approval that only an older head carries (the new head has none)', async () => {
      world.reviews = [botApproval(OLD_REVIEW_ID, OLD_HEAD)];
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([OLD_REVIEW_ID]);
    });

    it('withdraws an orphan approval of a repository that has bot approval off and no row', async () => {
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationBotApproval: false });
      world.reviews = [botApproval()];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(lastRow().botApproved).toBe(false);
    });

    it('withdraws every approval when the mode changed away from auto', async () => {
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationMode: 'enforce' });
      world.reviews = [botApproval(), botApproval(OLD_REVIEW_ID, OLD_HEAD)];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([BOT_REVIEW_ID, OLD_REVIEW_ID]);
    });

    it('withdraws nothing, and says so, when the approver App is no longer configured', async () => {
      world.config = null;
      world.reviews = [botApproval()];
      world.botRow = { botApproved: true, headSha: HEAD, id: 'row-old', reasons: [] };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out.statusState).toBe('pending');
      expect(dismissed()).toEqual([]);
      expect(rowCodes()).toContain('bot-approval-credentials-missing');
      expect(lastRow().botApproved).toBe(false);
      expect(getClient).not.toHaveBeenCalled();
    });

    it('takes the status back FIRST, then dismisses', async () => {
      world.reviews = [botApproval()];
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      const names = order();
      expect(names.indexOf('setCommitStatus')).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('setCommitStatus')).toBeLessThan(names.indexOf('dismissReview'));
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview']);
      expect(stateOf(statuses()[0])).not.toBe('success');
    });

    it('throws a retryable failure and dismisses nothing when the new status cannot be posted', async () => {
      world.reviews = [botApproval()];
      world.statusOk = false;
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
        nonRetryable: false,
        type: 'BOT_APPROVAL_STATUS_NOT_POSTED',
      });
      expect(dismissed()).toEqual([]);
      expect(m.created).toHaveLength(0);
    });

    it('throws a retryable failure when the last row for this head was bot-earned and the status cannot be posted', async () => {
      world.botRow = { botApproved: true, headSha: HEAD, id: 'row-old', reasons: [] };
      world.statusOk = false;
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
        nonRetryable: false,
      });
    });

    it('does not fail an evaluation whose status cannot be posted when nothing could be bot-earned', async () => {
      world.statusOk = false;
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationBotApproval: false });
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out.outcome).toBe('evaluated');
    });

    it('fails closed when a dismissal is refused: retryable, never a success status, no row', async () => {
      world.reviews = [botApproval()];
      world.dismissResult = { ok: false, reason: 'refused' };
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
        nonRetryable: false,
        type: 'BOT_APPROVAL_NOT_WITHDRAWN',
      });
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(m.created).toHaveLength(0);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('posts pending over a human-earned success when the bot approval could not be dismissed', async () => {
      world.reviews = [botApproval(), human()];
      world.dismissResult = { ok: false, reason: 'refused' };
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
        nonRetryable: false,
      });
      expect(statuses().map(stateOf).at(-1)).toBe('pending');
    });

    it('fails closed when a dismissal throws a non-retryable error, naming only the error', async () => {
      world.reviews = [botApproval()];
      world.dismissResult = 'throw';
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toMatchObject({
        nonRetryable: false,
      });
      expect(JSON.stringify(m.logs)).not.toContain(APP_TOKEN);
    });

    it('keeps the flag set (no row) so a retry withdraws again', async () => {
      world.reviews = [botApproval()];
      world.dismissResult = { ok: false, reason: 'not-found' };
      m.settings['prEvaluation.botApprovalAllowed'] = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(scmWith()))).rejects.toBeDefined();
      expect(m.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('a success status never stands beside an approval that must go, or an arming that must end', () => {
    const switchTo = (prEvaluationMode: string) =>
      m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationMode });
    const armedScm = (over: Partial<Record<keyof ScmProvider, unknown>> = {}) =>
      scmWith({ getPullRequest: async () => ARMED, ...over });

    it('auto -> advisory with a standing approval on an armed pull request: pending, dismiss, disarm, then success', async () => {
      switchTo('advisory');
      world.reviews = [botApproval()];
      const out = await evaluatePullRequestWith(INPUT, botDeps(armedScm()));
      expect(gateOrder()).toEqual([
        'status:pending',
        'dismissReview',
        'disableAutoMerge',
        'status:success',
      ]);
      expect(statuses()[0]).toEqual(INTERIM_STATUS);
      expect(stateOf(statuses()[1])).toBe('success');
      expect(argsOf('disableAutoMerge')).toHaveLength(1);
      expect(out).toMatchObject({ autoMerge: 'disabled', statusState: 'success' });
      expect(lastRow()).toMatchObject({ botApproved: false, statusState: 'success' });
      expect(JSON.stringify(m.update.mock.calls)).toContain('auto-disarmed-by-platform');
    });

    it('an advisory repository with a standing approval and nothing armed: pending, dismiss, then success', async () => {
      switchTo('advisory');
      world.reviews = [botApproval()];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'status:success']);
      expect(statuses()[0]).toEqual(INTERIM_STATUS);
    });

    it('an armed advisory pull request with no approval of the bot is disarmed after a non-success status', async () => {
      switchTo('advisory');
      await evaluatePullRequestWith(INPUT, botDeps(armedScm()));
      expect(gateOrder()).toEqual(['status:pending', 'disableAutoMerge', 'status:success']);
    });

    it('throws, and touches nothing else, when the interim status cannot be posted', async () => {
      switchTo('advisory');
      world.reviews = [botApproval()];
      world.statusOk = false;
      await expect(evaluatePullRequestWith(INPUT, botDeps(armedScm()))).rejects.toMatchObject({
        nonRetryable: false,
        type: 'BOT_APPROVAL_STATUS_NOT_POSTED',
      });
      expect(gateOrder()).toEqual(['status:pending']);
      expect(m.created).toHaveLength(0);
    });

    it('never publishes success when the dismissal fails, and leaves the arming for the retry', async () => {
      switchTo('advisory');
      world.reviews = [botApproval()];
      world.dismissResult = { ok: false, reason: 'refused' };
      await expect(evaluatePullRequestWith(INPUT, botDeps(armedScm()))).rejects.toMatchObject({
        type: 'BOT_APPROVAL_NOT_WITHDRAWN',
      });
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview']);
      expect(m.created).toHaveLength(0);
    });

    it('a bot approval that stands and is eligible keeps the single success status', async () => {
      world.reviews = [botApproval()];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(gateOrder()).toEqual(['status:success']);
    });

    it('a retired slug approval beside an eligible one is dismissed after an interim pending status', async () => {
      world.slugs = { active: BOT_SLUG, retired: ['old-app'] };
      world.reviews = [botApproval(), { ...botApproval('955'), login: 'old-app[bot]' }];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'status:success']);
      expect(dismissed()).toEqual(['955']);
    });
  });

  describe('an approver App that was removed or replaced', () => {
    const OLD_SLUG = 'old-approver';
    const oldApproval = (id = '960', commitId = HEAD): PullRequestReviewSummary => ({
      commitId,
      id,
      login: `${OLD_SLUG}[bot]`,
      state: 'APPROVED',
      submittedAt: null,
    });

    it('withdraws the old App approval with the credentials gone, and says the credentials are missing', async () => {
      world.config = null;
      world.slugs = { active: null, retired: [OLD_SLUG] };
      world.reviews = [oldApproval(), oldApproval('961', OLD_HEAD)];
      world.botRow = { botApproved: true, headSha: HEAD, id: 'row-old', reasons: [] };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual(['960', '961']);
      expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'dismissReview']);
      expect(out.statusState).toBe('pending');
      expect(rowCodes()).toContain('bot-approval-credentials-missing');
      expect(rowCodes().filter((c) => c === 'bot-approval-withdrawn')).toHaveLength(1);
      expect(rowCodes().filter((c) => c === 'bot-approval-withdrawn-older')).toHaveLength(1);
      expect(lastRow().botApproved).toBe(false);
      expect(getClient).not.toHaveBeenCalled();
    });

    it('recognises the replaced App and the new one, and keeps only the new one approving', async () => {
      world.slugs = { active: BOT_SLUG, retired: [OLD_SLUG] };
      world.reviews = [oldApproval()];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual(['960']);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('does not count a retired slug dismissal on this head against the person-dismissal rule when the platform made it', async () => {
      world.slugs = { active: BOT_SLUG, retired: [OLD_SLUG] };
      world.reviews = [{ ...oldApproval(), state: 'DISMISSED' }];
      m.markers.mockResolvedValue([
        {
          headSha: HEAD,
          reasons: [{ code: 'bot-approval-withdrawn', message: 'm', severity: 'info' }],
        },
      ]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(rowCodes()).not.toContain('bot-approval-suppressed');
    });

    it('writes no slug into any log, row, status or message', async () => {
      world.config = null;
      world.slugs = { active: null, retired: [OLD_SLUG] };
      world.reviews = [oldApproval()];
      world.botRow = { botApproved: true, headSha: HEAD, id: 'row-old', reasons: [] };
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      const everything = JSON.stringify([
        m.logs,
        m.created,
        m.update.mock.calls,
        argsOf('setCommitStatus'),
        argsOf('upsertMarkedComment'),
        argsOf('dismissReview').map((a) => a[3]),
      ]).toLowerCase();
      expect(everything).not.toContain(OLD_SLUG);
      expect(everything).not.toContain('"960"');
    });
  });

  describe('a dismissed request for changes still holds the bot back', () => {
    const OBJECTOR = 'zed-objector';
    const objection = (commitId = HEAD): PullRequestReviewSummary => ({
      commitId,
      id: '950',
      login: OBJECTOR,
      state: 'CHANGES_REQUESTED',
      submittedAt: null,
    });
    const dismissedObjection = (): PullRequestReviewSummary => ({
      ...objection(),
      state: 'DISMISSED',
    });
    const seenRow = () => ({
      headSha: OLD_HEAD,
      reasons: [{ code: 'human-objection-seen', message: 'm', severity: 'info' }],
    });
    const pages = (rows: unknown[]) => async (a: { skip?: number; take: number }) =>
      rows.slice(a.skip ?? 0, (a.skip ?? 0) + a.take);
    const filler = (n: number) =>
      Array.from({ length: n }, () => ({
        headSha: HEAD,
        reasons: [{ code: 'x', message: 'm', severity: 'info' }],
      }));

    it('records the objection it observes on the row, with a fixed message', async () => {
      world.reviews = [objection()];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(rowCodes()).toContain('human-objection-seen');
      expect(JSON.stringify(rowReasons())).not.toContain(OBJECTOR);
    });

    it('records nothing when nobody objects', async () => {
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(rowCodes()).not.toContain('human-objection-seen');
    });

    it('still refuses after somebody else dismissed the request', async () => {
      world.reviews = [dismissedObjection()];
      m.markers.mockResolvedValue([seenRow()]);
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(rowReasons().map((r) => r.message)).toContain(
        'Bot approval was not given: no-human-objection.'
      );
      expect(rowCodes()).toContain('human-objection-seen');
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('withdraws a standing bot approval when the request it was given over is dismissed', async () => {
      world.reviews = [botApproval(), dismissedObjection()];
      m.markers.mockResolvedValue([seenRow()]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(lastRow().botApproved).toBe(false);
    });

    it('lets the bot approve once a person approves the current head', async () => {
      world.reviews = [dismissedObjection(), human()];
      m.markers.mockResolvedValue([seenRow()]);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('does not take a person approval of an earlier commit, or the author or a bot, for that', async () => {
      m.markers.mockResolvedValue([seenRow()]);
      for (const extra of [
        { ...human(), commitId: OLD_HEAD },
        { ...human(), login: 'alice' },
        { ...human(), login: 'some-app[bot]' },
      ]) {
        world.reviews = [dismissedObjection(), extra];
        submit.mockClear();
        await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
        expect(submit).not.toHaveBeenCalled();
      }
    });

    it('still refuses on a new head with no person approval of it', async () => {
      world.reviews = [dismissedObjection(), human()];
      const next = 'c'.repeat(40);
      m.markers.mockResolvedValue([seenRow()]);
      m.steps.mockResolvedValue([
        { outputs: { codeResult: { headSha: next }, verdicts: [{ severity: 'PASS' }] } },
      ]);
      await evaluatePullRequestWith(
        INPUT,
        botDeps(scmWith({ getPullRequest: async () => ({ ...OPEN_PR, headSha: next }) }))
      );
      expect(submit).not.toHaveBeenCalled();
    });

    it('finds the marker on a later page, and reads at most 500 rows', async () => {
      world.reviews = [dismissedObjection()];
      m.markers.mockImplementation(pages([...filler(250), seenRow()]));
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      const reads = vi.fn(pages(filler(700)));
      m.markers.mockImplementation(reads);
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(reads.mock.calls.length).toBeLessThanOrEqual(10);
    });

    it('at the cap with no marker in sight, a dismissed request from a person is taken as still standing', async () => {
      world.reviews = [dismissedObjection()];
      m.markers.mockImplementation(pages([...filler(600), seenRow()]));
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
    });

    it('approves when the scan ends with no marker, however many rows it read', async () => {
      world.reviews = [dismissedObjection()];
      m.markers.mockImplementation(pages(filler(30)));
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('the sticky objection is lifted only by a trusted, non-launcher approval of the head', () => {
    const OBJECTOR = 'zed-objector';
    const dismissedObjection = (): PullRequestReviewSummary => ({
      commitId: HEAD,
      id: '950',
      login: OBJECTOR,
      state: 'DISMISSED',
      submittedAt: null,
    });
    const seenRow = () => ({
      headSha: OLD_HEAD,
      reasons: [{ code: 'human-objection-seen', message: 'm', severity: 'info' }],
    });
    const approvalBy = (login: string, commitId = HEAD): PullRequestReviewSummary => ({
      commitId,
      login,
      state: 'APPROVED',
      submittedAt: null,
    });
    beforeEach(() => {
      m.markers.mockResolvedValue([seenRow()]);
    });

    it('is not lifted by the approval of the person who launched the work', async () => {
      world.reviews = [dismissedObjection(), approvalBy(LAUNCHER_LOGIN)];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
    });

    it('is not lifted by the approval of someone without write access', async () => {
      world.reviews = [dismissedObjection(), approvalBy('drive-by')];
      await evaluatePullRequestWith(
        INPUT,
        botDeps(scmWith({ repoPermission: async () => ({ ok: true, permission: 'read' }) }))
      );
      expect(submit).not.toHaveBeenCalled();
    });

    it('is lifted by a trusted second person', async () => {
      world.reviews = [
        dismissedObjection(),
        approvalBy(LAUNCHER_LOGIN),
        approvalBy('second-human'),
      ];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('is not lifted by an approval of another commit', async () => {
      world.reviews = [dismissedObjection(), approvalBy('second-human', OLD_HEAD)];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('a failed submit leaves no approval of a retired App standing', () => {
    it('withdraws the retired approvals even though the submit failed', async () => {
      world.slugs = { active: BOT_SLUG, retired: ['old-app'] };
      world.submitResult = { ok: false, reason: 'refused' };
      world.reviews = [{ ...botApproval('971', OLD_HEAD), login: 'old-app[bot]' }];
      await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
      expect(dismissed()).toEqual(['971']);
    });
  });

  describe('an approver key that cannot be read', () => {
    it('is treated as no configuration in the main path, which still posts pending', async () => {
      loadConfig.mockRejectedValue(Object.assign(new Error(APP_TOKEN), { name: 'KeyBoom' }));
      world.slugs = { active: BOT_SLUG, retired: [] };
      world.reviews = [botApproval()];
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out).toMatchObject({ outcome: 'evaluated', statusState: 'pending' });
      expect(submit).not.toHaveBeenCalled();
      // The bot's login comes from the slugs, which need no key: its approval is withdrawn.
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(JSON.stringify(m.logs)).toContain('KeyBoom');
      expect(JSON.stringify(m.logs)).not.toContain(APP_TOKEN);
    });
  });

  describe('a status that cannot be posted after the approval', () => {
    it('keeps the evaluation, records the approval as standing, and arms nothing', async () => {
      world.statusOk = false;
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(out.outcome).toBe('evaluated');
      expect(submit).toHaveBeenCalledTimes(1);
      expect(dismissed()).toEqual([]);
      expect(lastRow().botApproved).toBe(true);
      expect(lastRow().readiness).toMatchObject({ statusPublished: { ok: false } });
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });
  });

  describe('the switches are read again, uncached, just before the approval is used', () => {
    it.each([
      [
        'autoMergeAllowed',
        'prEvaluation.autoMergeAllowed',
        'effective-mode-auto, auto-merge-allowed',
      ],
      ['botApprovalAllowed', 'prEvaluation.botApprovalAllowed', 'bot-approval-allowed'],
      ['enabled', 'prEvaluation.enabled', 'effective-mode-auto'],
    ] as const)(
      'submits nothing when %s is switched off while the evaluation runs',
      async (_n, key, condition) => {
        m.onInvalidate = () => {
          m.settings[key] = false;
        };
        const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
        expect(m.invalidated.count).toBeGreaterThanOrEqual(1);
        expect(submit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
        expect(out.statusState).toBe('pending');
        expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
        expect(argsOf('enableAutoMerge')).toHaveLength(0);
        expect(lastRow().botApproved).toBe(false);
        expect(rowReasons().map((r) => r.message)).toContain(
          `Bot approval was not given: ${condition}.`
        );
      }
    );

    it.each([
      ['the repository switch', { prEvaluationBotApproval: false }, 'repo-bot-approval'],
      ['the repository mode', { prEvaluationMode: 'enforce' }, 'effective-mode-auto'],
      ['the repository being deactivated', { isActive: false }, 'effective-mode-auto'],
    ] as const)(
      'submits nothing when %s changed while the evaluation runs',
      async (_n, patch, condition) => {
        m.connection.mockReset();
        m.connection
          .mockResolvedValueOnce(CONNECTION_ROW)
          .mockResolvedValue({ ...CONNECTION_ROW, ...patch });
        await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
        expect(submit).not.toHaveBeenCalled();
        expect(lastRow().botApproved).toBe(false);
        expect(rowReasons().map((r) => r.message)).toContain(
          `Bot approval was not given: ${condition}.`
        );
        expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      }
    );

    it.each([
      ['the base branch', { baseBranch: 'release' }],
      ['the head', { headSha: OLD_HEAD }],
      ['the draft flag', { draft: true }],
      ['open state', { state: 'closed' as const }],
    ] as const)('submits nothing when %s of the live pull request differs', async (_n, patch) => {
      let reads = 0;
      const scm = scmWith({
        getPullRequest: async () => {
          reads += 1;
          return reads >= 3 ? { ...OPEN_PR, ...patch } : OPEN_PR;
        },
      });
      await evaluatePullRequestWith(INPUT, botDeps(scm));
      expect(submit).not.toHaveBeenCalled();
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
    });

    it('does not report success for an approval that stands when a switch flipped before it counted', async () => {
      world.reviews = [botApproval()];
      m.onInvalidate = () => {
        m.settings['prEvaluation.botApprovalAllowed'] = false;
      };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).not.toHaveBeenCalled();
      expect(out.statusState).toBe('pending');
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(lastRow().botApproved).toBe(false);
    });

    it('withdraws a fresh approval, and reports no success, when a switch flips after the submit', async () => {
      let invalidations = 0;
      m.onInvalidate = () => {
        invalidations += 1;
        if (invalidations >= 2) {
          m.settings['prEvaluation.botApprovalAllowed'] = false;
        }
      };
      const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
      expect(submit).toHaveBeenCalledTimes(1);
      expect(out.statusState).toBe('pending');
      expect(dismissed()).toEqual([NEW_REVIEW_ID]);
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
      expect(lastRow().botApproved).toBe(false);
    });
  });

  describe('only changes to allowlisted paths are approved', () => {
    const doc = (path: string, extra: Record<string, unknown> = {}) => ({
      additions: 3,
      deletions: 1,
      patch: '@@ -1 +1 @@\n+text',
      path,
      status: 'modified' as const,
      ...extra,
    });
    const withFiles = (files: unknown[], truncated = false) =>
      scmWith({ listPullRequestFiles: async () => ({ files, truncated }) });
    const PATHS_REFUSAL = 'Bot approval was not given: bot-paths-allowed.';
    beforeEach(() => {
      m.settings['prEvaluation.botApprovalPaths'] = [...DEFAULT_BOT_APPROVAL_PATHS];
    });
    const expectRefusedOnPaths = () => {
      expect(submit).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(argsOf('enableAutoMerge')).toHaveLength(0);
      expect(lastRow().botApproved).toBe(false);
    };

    it('approves a change made only of documentation and tests', async () => {
      const out = await evaluatePullRequestWith(
        INPUT,
        botDeps(withFiles([doc('docs/guide.md'), doc('README.md'), doc('src/util.test.ts')]))
      );
      expect(submit).toHaveBeenCalledTimes(1);
      expect(out.statusState).toBe('success');
      expect(lastRow().botApproved).toBe(true);
    });

    it('refuses, and records exactly that reason, when one file is not on the list', async () => {
      await evaluatePullRequestWith(
        INPUT,
        botDeps(withFiles([doc('docs/guide.md'), doc('src/util.test.ts'), doc('src/util.ts')]))
      );
      expectRefusedOnPaths();
      expect(rowReasons().map((r) => r.message)).toContain(PATHS_REFUSAL);
    });

    it('refuses a rename from an allowlisted path to one that is not, and the reverse', async () => {
      for (const [path, previousPath] of [
        ['src/util.ts', 'docs/guide.md'],
        ['docs/guide.md', 'src/util.ts'],
      ]) {
        submit.mockClear();
        await evaluatePullRequestWith(
          INPUT,
          botDeps(
            withFiles([
              doc(path as string, { previousPath, status: 'renamed' }),
              doc('src/util.test.ts'),
            ])
          )
        );
        expectRefusedOnPaths();
        expect(rowReasons().map((r) => r.message)).toContain(PATHS_REFUSAL);
      }
    });

    it('approves a rename between two allowlisted paths', async () => {
      await evaluatePullRequestWith(
        INPUT,
        botDeps(withFiles([doc('docs/b.md', { previousPath: 'docs/a.md', status: 'renamed' })]))
      );
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('refuses when the file list is truncated, however the listed files look', async () => {
      await evaluatePullRequestWith(INPUT, botDeps(withFiles([doc('docs/guide.md')], true)));
      expectRefusedOnPaths();
      expect(
        rowReasons()
          .map((r) => r.message)
          .join('\n')
      ).toContain('bot-paths-allowed');
    });

    it('refuses when the allowlist is empty, or no longer a valid list', async () => {
      for (const value of [[], ['{unclosed'], undefined, 'docs/**']) {
        submit.mockClear();
        m.settings['prEvaluation.botApprovalPaths'] = value;
        await evaluatePullRequestWith(INPUT, botDeps(withFiles([doc('docs/guide.md')])));
        expectRefusedOnPaths();
        expect(rowReasons().map((r) => r.message)).toContain(PATHS_REFUSAL);
      }
    });

    it('re-reads the allowlist, uncached, just before the submit', async () => {
      m.onInvalidate = () => {
        m.settings['prEvaluation.botApprovalPaths'] = ['**/*.mdx'];
      };
      const out = await evaluatePullRequestWith(INPUT, botDeps(withFiles([doc('docs/guide.md')])));
      expect(m.invalidated.count).toBeGreaterThanOrEqual(1);
      expect(submit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(out.statusState).toBe('pending');
      expect(lastRow().botApproved).toBe(false);
      expect(rowReasons().map((r) => r.message)).toContain(PATHS_REFUSAL);
    });

    it('does not approve a sensitive path just because the allowlist also matches it', async () => {
      const out = await evaluatePullRequestWith(
        INPUT,
        botDeps(withFiles([doc('docs/migrations/x.sql'), doc('AGENTS.md')]))
      );
      expectRefusedOnPaths();
      expect(out.riskClass).toBe('HIGH');
      expect(
        rowReasons()
          .map((r) => r.message)
          .join('\n')
      ).toContain('risk-low');
    });

    it('withdraws a standing approval, and reports no success, when the allowlist is tightened', async () => {
      world.reviews = [botApproval()];
      m.settings['prEvaluation.botApprovalPaths'] = ['**/*.mdx'];
      const out = await evaluatePullRequestWith(INPUT, botDeps(withFiles([doc('docs/guide.md')])));
      expect(submit).not.toHaveBeenCalled();
      expect(dismissed()).toEqual([BOT_REVIEW_ID]);
      expect(out.statusState).toBe('pending');
      expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
      expect(lastRow().botApproved).toBe(false);
    });
  });

  it('does not approve, and records the refusal, when the repository policy file asks for two approvers', async () => {
    const out = await evaluatePullRequestWith(
      INPUT,
      botDeps(scmWith({ fetchFileContent: async () => 'version: 1\nlowApprovers: 2\n' }))
    );
    expect(submit).not.toHaveBeenCalled();
    expect(out.statusState).toBe('pending');
    expect(lastRow().botApproved).toBe(false);
    expect(rowReasons().map((r) => r.message)).toContain(
      'Bot approval was not given: no-stricter-approver-count.'
    );
  });

  it('approves when one approver is required, in the registry and the policy file', async () => {
    const out = await evaluatePullRequestWith(
      INPUT,
      botDeps(scmWith({ fetchFileContent: async () => 'version: 1\nlowApprovers: 1\n' }))
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(out.statusState).toBe('success');
    expect(lastRow().botApproved).toBe(true);
  });

  it('withdraws a standing approval, and reports no success, when the approver count is raised', async () => {
    world.reviews = [botApproval()];
    m.settings['prEvaluation.lowApprovers'] = 2;
    const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(submit).not.toHaveBeenCalled();
    expect(dismissed()).toEqual([BOT_REVIEW_ID]);
    expect(statuses().every((st) => stateOf(st) !== 'success')).toBe(true);
    expect(out.statusState).not.toBe('success');
    expect(lastRow().botApproved).toBe(false);
  });

  it('does nothing about bots, and mints no token, when the repository never used it and nothing stands', async () => {
    m.connection.mockResolvedValue({ ...CONNECTION_ROW, prEvaluationBotApproval: false });
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(getClient).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(dismissed()).toEqual([]);
    expect(lastRow().botApproved).toBe(false);
    expect(lastRow().readiness).not.toHaveProperty('botApproval');
  });

  it('submits nothing when the head moved during the evaluation', async () => {
    let reads = 0;
    const scm = scmWith({
      getPullRequest: async () => {
        reads += 1;
        return reads === 1 ? OPEN_PR : { ...OPEN_PR, headSha: OLD_HEAD };
      },
    });
    const out = await evaluatePullRequestWith(INPUT, botDeps(scm));
    expect(out.outcome).toBe('superseded');
    expect(submit).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it('fails closed when loading the approver configuration throws', async () => {
    loadConfig.mockRejectedValue(Object.assign(new Error(APP_TOKEN), { name: 'ConfigBoom' }));
    const out = await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    expect(out).toMatchObject({ outcome: 'evaluated', statusState: 'pending' });
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.stringify(m.logs)).toContain('ConfigBoom');
    expect(JSON.stringify(m.logs)).not.toContain(APP_TOKEN);
  });

  it('never puts a login, slug, app token or review id in a log, row, status, comment or body', async () => {
    world.reviews = [botApproval(), botApproval(OLD_REVIEW_ID, OLD_HEAD)];
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    world.reviews = [];
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    world.reviews = [botApproval(), botApproval(OLD_REVIEW_ID, OLD_HEAD)];
    m.settings['prEvaluation.botApprovalAllowed'] = false;
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    world.dismissResult = { ok: false, reason: 'refused' };
    await evaluatePullRequestWith(INPUT, botDeps(scmWith())).catch(() => undefined);
    world.submitResult = 'throw';
    world.reviews = [];
    m.settings['prEvaluation.botApprovalAllowed'] = true;
    await evaluatePullRequestWith(INPUT, botDeps(scmWith()));
    const everything = JSON.stringify([
      m.logs,
      m.created,
      m.update.mock.calls,
      argsOf('setCommitStatus'),
      argsOf('upsertMarkedComment'),
      submit.mock.calls.map((c) => c[3]),
      argsOf('dismissReview').map((a) => a[3]),
    ]);
    for (const secret of [
      BOT_LOGIN,
      BOT_SLUG,
      APP_TOKEN,
      BOT_REVIEW_ID,
      OLD_REVIEW_ID,
      NEW_REVIEW_ID,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('evaluatePullRequest: bot approval when evaluation is off', () => {
  const BOT_LOGIN = 'approver-app[bot]';
  const WITHDRAWN = {
    context: 'auto-swe/pr-evaluation',
    description: 'Evaluation is switched off: this status is no longer maintained',
    state: 'pending',
  };
  const getClient = vi.fn();
  const loadConfig = vi.fn();
  const submit = vi.fn();

  const botRow = (headSha = HEAD) => ({
    botApproved: true,
    headSha,
    id: 'row-bot',
    reasons: [{ code: 'bot-approval-posted', message: 'x', severity: 'info' }],
  });
  let rowForBot: ReturnType<typeof botRow> | null;
  let reviews: PullRequestReviewSummary[];
  let dismissResult: { ok: boolean; reason?: string };
  let statusOk: boolean;

  const review = (id: string, commitId = HEAD, state = 'APPROVED'): PullRequestReviewSummary => ({
    commitId,
    id,
    login: BOT_LOGIN,
    state,
    submittedAt: null,
  });

  beforeEach(() => {
    rowForBot = null;
    slugs = undefined;
    reviews = [review('901')];
    dismissResult = { ok: true };
    statusOk = true;
    for (const f of [getClient, loadConfig, submit]) {
      f.mockReset();
    }
    loadConfig.mockResolvedValue({ appSlug: 'approver-app' });
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : null
    );
    m.settings['prEvaluation.enabled'] = false;
  });

  let slugs: { active: string | null; retired: string[] } | undefined;
  const deps = (scm: Fake): EvaluatePullRequestDeps => ({
    ...depsWith(scm),
    approver: {
      getClient,
      loadBotSlugs: slugs ? async () => slugs : undefined,
      loadConfig,
      submit,
    } as never,
  });
  const scm = (over: Partial<Record<keyof ScmProvider, unknown>> = {}) =>
    fakeScm({
      dismissReview: async (...args: unknown[]) => {
        m.calls.push({ args, name: 'dismissReview' });
        return dismissResult;
      },
      listPullRequestReviews: async (...args: unknown[]) => {
        m.calls.push({ args, name: 'listPullRequestReviews' });
        return reviews;
      },
      setCommitStatus: async (...args: unknown[]) => {
        m.calls.push({ args, name: 'setCommitStatus' });
        return statusOk ? { ok: true } : { ok: false, reason: 'nope' };
      },
      ...over,
    });
  const statuses = () => argsOf('setCommitStatus').map((a) => a[2]);
  const dismissed = () => argsOf('dismissReview').map((a) => a[2]);

  it('posts pending, then dismisses the approval through the platform and records it when the feature is off', async () => {
    rowForBot = botRow();
    const fake = scm();
    const result = await evaluatePullRequestWith(INPUT, deps(fake));
    expect(result.outcome).toBe('skipped');
    expect(statuses()).toEqual([WITHDRAWN]);
    expect(argsOf('setCommitStatus')[0]?.[1]).toBe(HEAD);
    expect(argsOf('dismissReview')).toEqual([
      [
        expect.objectContaining({ organizationName: 'acme' }),
        7,
        '901',
        'The auto-swe evaluator withdrew its approval: the conditions for approving no longer hold.',
      ],
    ]);
    const names = m.calls.map((c) => c.name);
    expect(names.indexOf('setCommitStatus')).toBeLessThan(names.indexOf('dismissReview'));
    expect(getClient).not.toHaveBeenCalled();
    expect(m.created).toHaveLength(0);
    expect(m.updateMany).toHaveBeenCalledWith({
      data: { botApproved: false },
      where: { botApproved: true, connectionId: CONNECTION, prNumber: 7 },
    });
    const updated = m.update.mock.calls[0]?.[0] as {
      data: { reasons: { code: string }[] };
      where: { id: string };
    };
    expect(updated.where).toEqual({ id: 'row-bot' });
    expect(updated.data.reasons.map((r) => r.code)).toContain('bot-approval-withdrawn');
    expect(fake.calls).not.toContain('enableAutoMerge');
    expect(submit).not.toHaveBeenCalled();
  });

  it('does the same for an inactive repository and a repository mode of off', async () => {
    m.settings['prEvaluation.enabled'] = true;
    for (const patch of [{ isActive: false }, { prEvaluationMode: 'off' }]) {
      m.connection.mockResolvedValue({
        githubApiUrl: null,
        githubUrl: null,
        id: CONNECTION,
        installation: null,
        isActive: true,
        organizationName: 'acme',
        prEvaluationMode: null,
        repoName: 'widgets',
        team: { orgId: 'org-1' },
        teamId: 'team-1',
        ...patch,
      });
      rowForBot = botRow();
      m.calls = [];
      await evaluatePullRequestWith(INPUT, deps(scm()));
      expect(statuses()).toEqual([WITHDRAWN]);
      expect(dismissed()).toEqual(['901']);
    }
  });

  it('withdraws every standing approval of every commit, even with no row recording one', async () => {
    reviews = [review('901'), review('902', OLD_HEAD), review('903', OLD_HEAD, 'DISMISSED')];
    await evaluatePullRequestWith(INPUT, deps(scm()));
    expect(statuses()).toEqual([WITHDRAWN]);
    expect(dismissed()).toEqual(['901', '902']);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('looks for an approval of its own on every skip, and touches nothing when none stands', async () => {
    reviews = [{ ...review('901'), login: 'someone-else' }];
    const fake = scm();
    const result = await evaluatePullRequestWith(INPUT, deps(fake));
    expect(result.outcome).toBe('skipped');
    expect(m.calls.map((c) => c.name)).toEqual(['getPullRequest', 'listPullRequestReviews']);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('calls nothing on the host when no approver App is configured and no row recorded one', async () => {
    loadConfig.mockResolvedValue(null);
    const fake = scm();
    const result = await evaluatePullRequestWith(INPUT, deps(fake));
    expect(result.outcome).toBe('skipped');
    expect(fake.calls).toEqual([]);
  });

  it('withdraws nothing when the approver App is gone, but takes the status back and says why', async () => {
    loadConfig.mockResolvedValue(null);
    rowForBot = botRow();
    await evaluatePullRequestWith(INPUT, deps(scm()));
    expect(statuses()).toEqual([WITHDRAWN]);
    expect(dismissed()).toEqual([]);
    const updated = m.update.mock.calls[0]?.[0] as { data: { reasons: { code: string }[] } };
    expect(updated.data.reasons.map((r) => r.code)).toContain('bot-approval-credentials-missing');
    expect(m.updateMany).toHaveBeenCalled();
  });

  it('posts no status for a row of an older head with nothing standing, but clears the flag', async () => {
    rowForBot = botRow(OLD_HEAD);
    reviews = [];
    const fake = scm();
    await evaluatePullRequestWith(INPUT, deps(fake));
    expect(statuses()).toEqual([]);
    expect(m.updateMany).toHaveBeenCalledWith({
      data: { botApproved: false },
      where: { botApproved: true, connectionId: CONNECTION, prNumber: 7 },
    });
  });

  it('withdraws an approval of an older head even when the row names it', async () => {
    rowForBot = botRow(OLD_HEAD);
    reviews = [review('902', OLD_HEAD)];
    await evaluatePullRequestWith(INPUT, deps(scm()));
    expect(dismissed()).toEqual(['902']);
    expect(statuses()).toEqual([WITHDRAWN]);
  });

  it('throws a retryable failure and keeps the flag when a dismissal fails, after the pending status is posted', async () => {
    rowForBot = botRow();
    dismissResult = { ok: false, reason: 'refused' };
    await expect(evaluatePullRequestWith(INPUT, deps(scm()))).rejects.toMatchObject({
      nonRetryable: false,
      type: 'BOT_APPROVAL_NOT_WITHDRAWN',
    });
    expect(statuses()).toEqual([WITHDRAWN]);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('throws a retryable failure, dismissing nothing, when the pending status cannot be posted', async () => {
    rowForBot = botRow();
    statusOk = false;
    await expect(evaluatePullRequestWith(INPUT, deps(scm()))).rejects.toMatchObject({
      nonRetryable: false,
    });
    expect(dismissed()).toEqual([]);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('still disarms an armed row alongside a bot row', async () => {
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved
        ? rowForBot
        : { autoMergeEnabled: true, headSha: HEAD, id: 'row-armed', reasons: [] }
    );
    const fake = scm({ getPullRequest: async () => ARMED });
    const result = await evaluatePullRequestWith(INPUT, deps(fake));
    expect(result.autoMerge).toBe('disabled');
    expect(statuses()).toEqual([WITHDRAWN]);
  });

  const gateOrder = () =>
    m.calls
      .map((c) =>
        c.name === 'setCommitStatus' ? `status:${(c.args[2] as { state: string }).state}` : c.name
      )
      .filter((n) => n === 'dismissReview' || n === 'disableAutoMerge' || n.startsWith('status:'));
  const armedRowFor = () => ({
    autoMergeEnabled: true,
    headSha: HEAD,
    id: 'row-armed',
    reasons: [],
  });

  it('takes the status back and dismisses the approval BEFORE it disarms', async () => {
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    const result = await evaluatePullRequestWith(
      INPUT,
      deps(scm({ getPullRequest: async () => ARMED }))
    );
    expect(result.autoMerge).toBe('disabled');
    expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'disableAutoMerge']);
  });

  it('does the same, in the same order, for the kill switch sweep', async () => {
    m.settings['prEvaluation.enabled'] = false;
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    await evaluatePullRequestWith(
      { ...INPUT, trigger: 'disarm-sweep' },
      deps(scm({ getPullRequest: async () => ARMED }))
    );
    expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'disableAutoMerge']);
  });

  it('an auto -> off repository follows the same order', async () => {
    m.settings['prEvaluation.enabled'] = true;
    m.connection.mockResolvedValue({
      githubApiUrl: null,
      githubUrl: null,
      id: CONNECTION,
      installation: null,
      isActive: true,
      organizationName: 'acme',
      prEvaluationMode: 'off',
      repoName: 'widgets',
      team: { orgId: 'org-1' },
      teamId: 'team-1',
    });
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    await evaluatePullRequestWith(INPUT, deps(scm({ getPullRequest: async () => ARMED })));
    expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'disableAutoMerge']);
  });

  it('does not disarm when the status for a standing approval cannot be posted', async () => {
    rowForBot = botRow();
    statusOk = false;
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    await expect(
      evaluatePullRequestWith(INPUT, deps(scm({ getPullRequest: async () => ARMED })))
    ).rejects.toMatchObject({ nonRetryable: false });
    expect(gateOrder()).toEqual(['status:pending']);
  });

  it('withdraws an old App approval after the App was deleted, naming only its retired slug', async () => {
    loadConfig.mockResolvedValue(null);
    slugs = { active: null, retired: ['old-app'] };
    reviews = [
      { ...review('970'), login: 'old-app[bot]' },
      { ...review('971'), login: 'someone' },
    ];
    rowForBot = botRow();
    await evaluatePullRequestWith(INPUT, deps(scm()));
    expect(statuses()).toEqual([WITHDRAWN]);
    expect(dismissed()).toEqual(['970']);
    const updated = m.update.mock.calls[0]?.[0] as { data: { reasons: { code: string }[] } };
    expect(updated.data.reasons.map((r) => r.code)).toContain('bot-approval-credentials-missing');
    expect(JSON.stringify([m.logs, m.update.mock.calls, statuses()])).not.toContain('old-app');
  });

  it('looks at the review list for a retired slug even with no row and no credentials', async () => {
    loadConfig.mockResolvedValue(null);
    slugs = { active: null, retired: ['old-app'] };
    reviews = [{ ...review('970'), login: 'old-app[bot]' }];
    await evaluatePullRequestWith(INPUT, deps(scm()));
    expect(dismissed()).toEqual(['970']);
  });

  it('still withdraws and disarms when the approver key cannot be read', async () => {
    loadConfig.mockRejectedValue(Object.assign(new Error('secret-text'), { name: 'KeyBoom' }));
    slugs = { active: 'approver-app', retired: [] };
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    const result = await evaluatePullRequestWith(
      INPUT,
      deps(scm({ getPullRequest: async () => ARMED }))
    );
    expect(result.autoMerge).toBe('disabled');
    expect(gateOrder()).toEqual(['status:pending', 'dismissReview', 'disableAutoMerge']);
    expect(JSON.stringify(m.logs)).toContain('KeyBoom');
    expect(JSON.stringify(m.logs)).not.toContain('secret-text');
  });

  it('posts pending and disarms even when neither the key nor the slugs can be read', async () => {
    loadConfig.mockRejectedValue(new Error('x'));
    slugs = undefined;
    rowForBot = botRow();
    m.previous.mockImplementation(async (args: { where: { botApproved?: boolean } }) =>
      args.where.botApproved ? rowForBot : armedRowFor()
    );
    const result = await evaluatePullRequestWith(
      INPUT,
      deps(scm({ getPullRequest: async () => ARMED }))
    );
    expect(result.autoMerge).toBe('disabled');
    expect(dismissed()).toEqual([]);
    expect(gateOrder()).toEqual(['status:pending', 'disableAutoMerge']);
  });

  it('never puts the bot login, slug or review id in a log, row or status', async () => {
    rowForBot = botRow();
    reviews = [review('901'), review('902', OLD_HEAD)];
    await evaluatePullRequestWith(INPUT, deps(scm()));
    dismissResult = { ok: false, reason: 'refused' };
    await evaluatePullRequestWith(INPUT, deps(scm())).catch(() => undefined);
    const everything = JSON.stringify([
      m.logs,
      m.update.mock.calls,
      argsOf('setCommitStatus'),
      argsOf('dismissReview').map((a) => a[3]),
    ]);
    for (const secret of [BOT_LOGIN, 'approver-app', '901', '902']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('boundReasons keeps every safety marker', () => {
  const MARKERS = [
    'human-objection-seen',
    'bot-approval-suppressed',
    'bot-approval-withdrawn',
    'bot-approval-withdrawn-older',
    'auto-armed',
    'auto-disarmed-by-platform',
    'auto-suppressed-human',
  ];
  const reason = (code: string) => ({ code, message: 'm', severity: 'info' as const });

  it('drops none of them behind 150 ordinary reasons', () => {
    const ordinary = Array.from({ length: 150 }, (_, i) => reason(`ordinary-${i}`));
    const out = boundReasons([...ordinary, ...MARKERS.map(reason)]).map((r) => r.code);
    for (const code of MARKERS) {
      expect(out).toContain(code);
    }
  });

  it('keeps every dismissal entry and still bounds the ordinary reasons', () => {
    const ordinary = Array.from({ length: 150 }, (_, i) => reason(`ordinary-${i}`));
    const withdrawn = Array.from({ length: 7 }, () => reason('bot-approval-withdrawn'));
    const out = boundReasons([...ordinary, ...MARKERS.map(reason), ...withdrawn]);
    expect(out.filter((r) => r.code === 'bot-approval-withdrawn')).toHaveLength(8);
    expect(out.length).toBe(100);
  });

  it('leaves a short list as it was', () => {
    const list = [reason('a'), reason('human-objection-seen'), reason('b')];
    expect(boundReasons(list).map((r) => r.code)).toEqual(['a', 'human-objection-seen', 'b']);
  });
});
