import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  evidence: { bad: 0, low: 200 },
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
      count: vi.fn(async (args: { where: { badMerge?: boolean } }) =>
        args.where.badMerge === true ? m.evidence.bad : m.evidence.low
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        m.created.push(args.data);
        return { id: `row-${m.created.length}` };
      }),
      findFirst: m.previous,
      findMany: m.markers,
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

import { ApplicationFailure } from '@temporalio/activity';
import {
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
  'prEvaluation.autoMergeAllowed': true,
  'prEvaluation.autoMinEvidence': 150,
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
  m.evidence = { bad: 0, low: 200 };
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
        m.evidence = { bad: 0, low: 149 };
      },
      {},
    ],
    [
      'a bad merge is on record',
      () => {
        m.evidence = { bad: 1, low: 500 };
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
