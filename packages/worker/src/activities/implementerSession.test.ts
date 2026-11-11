import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withEndMarker } from './pinnedGitTestSupport.js';

vi.mock('../lib/runKnowledgeBases.js', () => ({
  loadRunKnowledgeBases: vi.fn(async () => ({ checkouts: [], snapshotIds: [] })),
}));

// Which loop drives the implementer is a run-pinned setting; these tests are about
// the Mastra loop, so the registry read answers without a database.
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: vi.fn(async () => 'mastra'),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    connection: { findUniqueOrThrow: vi.fn() },
  },
}));

// heartbeat() throws outside a real activity context; keep ApplicationFailure real.
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: () => {},
}));

const pushEffect = vi.hoisted(() =>
  vi.fn(async (_b: string, _s: unknown, push: () => unknown) => push())
);
vi.mock('../lib/effectLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/effectLedger.js')>()),
  recordGitPush: pushEffect,
}));

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    token: 'tok',
  })),
}));

// Clone URL + token resolution moved from systemConfig/githubAuth call sites
// into the ScmProvider seam (lib/scm).
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: vi.fn(async () => ({
      authedCloneUrl: 'https://x-access-token:tok@github.com/org/app.git',
      cloneUrl: 'https://github.com/org/app.git',
      token: 'tok',
    })),
  }),
  toRepoRef: (repo: Record<string, unknown>) => repo,
}));

// The default branch's tip and the commit the checkout is at are different commits, so the diff
// is between two distinct shas and an empty read for a different tree is reachable.
const DEFAULT_TIP = 'd'.repeat(40);
const execMock = vi.fn(async (cmd: string, _options?: { timeoutMs?: number }) => {
  if (cmd.includes('merge-base --is-ancestor')) {
    return 'rc=0\n';
  }
  if (cmd.includes('refs/remotes/origin/')) {
    // The resume rebase reads the fetched remote ref fully qualified and wants a full id.
    return `${'a'.repeat(40)}\n`;
  }
  if (cmd.includes('rev-parse --verify')) {
    // A readable commit, for the pinned reads the diff is built from.
    return `${cmd.includes('origin/') ? DEFAULT_TIP : 'e'.repeat(40)}\n`;
  }
  if (cmd.includes('merge-base')) {
    return `${DEFAULT_TIP}\n`;
  }
  if (cmd.includes('rev-parse')) {
    return 'abc123\n';
  }
  if (cmd.includes('diff-tree') && cmd.includes(' --text ')) {
    return withEndMarker(cmd, 'diff --git a/x b/x');
  }
  if (cmd.includes('cat package.json')) {
    return '{}';
  }
  if (cmd.endsWith('} 2>&1')) {
    // The test run: a green suite has to show that tests ran.
    return 'Tests  3 passed (3)';
  }
  return '';
});
// Mirrors the real gitAuthed: injects a (fake) credential header per-call and
// forwards to the same underlying exec recording/return-value logic above,
// so existing `execMock`-based command matchers still apply to these calls.
const gitAuthedMock = vi.fn((subcommand: string) =>
  execMock(`git -c http.extraheader='AUTHORIZATION: basic redacted' ${subcommand}`)
);
const destroyMock = vi.fn(async () => {});
const runSetupMock = vi.fn(async () => {});
vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(async () => ({
    containerId: 'workspace-test',
    destroy: destroyMock,
    exec: execMock,
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
    gitAuthed: gitAuthedMock,
    runSetup: runSetupMock,
  })),
  fetchBranchesSubcommand: (branches: string[]) =>
    `fetch origin ${branches.map((b) => `'+refs/heads/${b}:refs/remotes/origin/${b}'`).join(' ')}`,
  gitWithAuthHeader: (s: string) => `HARDENED git ${s}`,
  shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
}));

const generateMock = vi.fn(async (..._args: unknown[]) => ({
  text: 'fixed it',
  usage: { inputTokens: 10, outputTokens: 5 },
}));
const buildImplementerMock = vi.fn(async (..._args: unknown[]) => ({
  agent: { generate: generateMock },
  maxSteps: 42,
  promptSuffix: '',
  skills: [],
  toolKeys: null,
}));
const getBoundModelMock = vi.fn(async (..._args: unknown[]) => ({
  agent: { id: 'agent-row-4', version: 4 },
  model: {},
  spec: 'anthropic/v4-model',
  systemPrompt: null,
}));

vi.mock('../agents/implementer.js', () => ({
  buildImplementerForActivity: (...args: unknown[]) => buildImplementerMock(...args),
}));

const scanDiffForSecurityIssuesMock = vi.fn(async (_diff: string) => ({
  findings: [] as unknown[],
  passed: true,
}));
vi.mock('../agents/securityReviewProcessor.js', () => ({
  scanDiffForSecurityIssues: (diff: string) => scanDiffForSecurityIssuesMock(diff),
}));

const scanDiffForCodeIssuesMock = vi.fn(async (_diff: string) => [] as unknown[]);
vi.mock('../lib/codeSecurityScanner.js', () => ({
  scanDiffForCodeIssues: (diff: string) => scanDiffForCodeIssuesMock(diff),
}));

const persistMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: () => 'wf-1',
  currentWorkflowRunId: async () => 'run-1',
  persistActivityTrace: (...args: unknown[]) => persistMock(...args),
}));

const recordLlmUsageMock = vi.fn(async (..._args: unknown[]) => ({
  costUsd: 0,
  inputTokens: 0,
  modelSpec: '',
  outputTokens: 0,
}));
const { assertRolePricedMock } = vi.hoisted(() => ({
  assertRolePricedMock: vi.fn(async (_role: string) => {}),
}));
vi.mock('../lib/usdCapGuard.js', () => ({
  assertRolePricedForUsdCap: assertRolePricedMock,
  // The security gate passes spend refusals through; the real check reads the type.
  isSpendRefusal: (err: unknown) =>
    ['BUDGET_EXCEEDED', 'MODEL_PRICE_UNAVAILABLE', 'MODEL_UNPRICED'].includes(
      (err as { type?: string } | null)?.type ?? ''
    ),
}));
const unpriced = () =>
  Object.assign(new Error('Model has no price in the model catalog'), { type: 'MODEL_UNPRICED' });

vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: (...args: unknown[]) => recordLlmUsageMock(...args),
}));

vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn(async () => []),
  loadAgentToolConfig: vi.fn(async () => null),
}));

// The loop choice has its own tests (agentRuntime, implementerRuntimeSelect);
// these drive the Mastra loop, the default.
vi.mock('../lib/config/agentRuntime.js', () => ({
  resolveAgentRuntime: vi.fn(async () => ({ runtime: 'mastra', source: 'default' })),
}));
// The approved-profile lookup reads the Agent row; these tests bind no profile.
vi.mock('../lib/config/harnessProfile.js', () => ({
  resolveProfileForRuntime: vi.fn(async () => undefined),
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));

vi.mock('../lib/config/mcpConnection.js', () => ({
  resolveAgentMcpBinding: vi.fn(async () => ({ kind: 'none' })),
  resolveAgentMcpUrl: vi.fn(async () => null),
}));

// Every seeded Agent row carries its own systemPrompt, so a resolver mock
// that ignores the role and returns the fallback cannot tell 'implementer'
// from 'ciFixer' — which is exactly how the fix paths ran the implementer's
// prompt unnoticed. Resolve per role, like the real cascade.
const SEEDED_PROMPTS: Record<string, string> = {
  ciFixer: 'CI FIXER ROW PROMPT',
  gateFixer: 'GATE FIXER ROW PROMPT',
  implementer: 'IMPLEMENTER ROW PROMPT',
  reviewFixer: 'REVIEW FIXER ROW PROMPT',
};
vi.mock('../lib/models.js', () => ({
  getBoundModel: (...args: unknown[]) => getBoundModelMock(...args),
  resolveSystemPrompt: vi.fn(
    async (role: string, fallback: string, override?: string) =>
      override || SEEDED_PROMPTS[role] || fallback
  ),
}));

import { resolveSetting } from '@auto-swe/shared/config';

vi.mock('../lib/pauseSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/pauseSnapshot.js')>()),
  restoreWorkingTree: vi.fn(async () => {}),
  snapshotWorkingTree: vi.fn(async () => ({
    snapshot: {
      artifactId: 'art-9',
      baseSha: 'a'.repeat(40),
      bytes: 321,
      sha256: 'c'.repeat(64),
    },
  })),
}));

// Passes through to the real runner builder; the ask-and-resume tests hand it a fake one.
vi.mock('../agents/implementerRuntimeSelect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/implementerRuntimeSelect.js')>();
  return { ...actual, buildImplementerTurnRunner: vi.fn(actual.buildImplementerTurnRunner) };
});

import { prisma } from '@auto-swe/shared/db';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { buildImplementerTurnRunner } from '../agents/implementerRuntimeSelect.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { QUESTIONS, resumeInputFor } from '../lib/pauseResumeFixtures.js';
import { restoreWorkingTree, snapshotWorkingTree } from '../lib/pauseSnapshot.js';
import { type FixSessionInput, runImplementerFixSession } from './implementerSession.js';

const findRepo = vi.mocked(prisma.connection.findUniqueOrThrow);
const findWorkflow = vi.mocked(prisma.activeWorkflow.findFirst);

const REPO = {
  defaultBranch: 'main',
  executorImage: null,
  githubUrl: null,
  id: 'repo-1',
  organizationName: 'org',
  repoName: 'app',
};

function codeResult(overrides: Partial<CodeResult> = {}): CodeResult {
  return {
    branch: 'auto/T-1',
    diff: 'old diff',
    filesChanged: [],
    headSha: 'prev',
    implementationNotes: '',
    testResults: { duration_ms: 0, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
    ...overrides,
  };
}

function input(overrides: Partial<Omit<FixSessionInput, 'allowPause' | 'resumeInput'>> = {}) {
  return {
    agentKey: 'ciFixer',
    commitMessage: 'auto: fix CI for auto/T-1',
    defaultSystemPrompt: 'FIX THINGS',
    mode: 'CI_FIX' as const,
    notes: (t: { passed: boolean }, extra: string | null) =>
      `notes(${t.passed}${extra ? `, ${extra}` : ''})`,
    previousCodeResult: codeResult({ repoId: 'repo-1' }),
    usageEventName: 'llm.ci_fix',
    userPayload: { ciLogs: 'boom' },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runImplementerFixSession allowedPaths', () => {
  const BASE = 'b'.repeat(40);
  const stage = (names: string) => {
    const base = execMock.getMockImplementation();
    execMock.mockImplementation((async (cmd: string, options?: { timeoutMs?: number }) => {
      if (cmd.includes('rev-parse --verify')) {
        return `${cmd.includes('origin/') ? DEFAULT_TIP : BASE}\n`;
      }
      return cmd.includes('diff-tree') && !cmd.includes(' --text ')
        ? withEndMarker(cmd, names)
        : base?.(cmd, options);
    }) as never);
    return base;
  };
  const cmds = () => execMock.mock.calls.map((c) => c[0]);

  it('fails before the push when the committed range names a file outside the list', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const base = stage('a.ts\0package.json\0');
    try {
      await expect(
        runImplementerFixSession(input({ allowedPaths: ['a.ts'] }))
      ).rejects.toMatchObject({ nonRetryable: true, type: 'DIFF_OUTSIDE_ALLOWED_PATHS' });
      expect(cmds().some((c) => c.includes('push origin'))).toBe(false);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('pushes a change inside the list, measured from the commit it started at', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const base = stage('a.ts\0');
    try {
      await runImplementerFixSession(input({ allowedPaths: ['a.ts'] }));
      expect(cmds().some((c) => c.includes(`push origin ${BASE}:refs/heads/'auto/T-1'`))).toBe(
        true
      );
      expect(cmds().some((c) => c.includes(`${BASE} ${BASE}`))).toBe(true);
      expect(pushEffect).toHaveBeenCalledWith('auto/T-1', BASE, expect.any(Function));
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('records the starting commit and the guard base before the setup command runs repository code', async () => {
    findRepo.mockResolvedValue(REPO as never);
    runSetupMock.mockClear();
    const base = stage('a.ts\0');
    try {
      await runImplementerFixSession(input({ allowedPaths: ['a.ts'] }));
      expect(runSetupMock).toHaveBeenCalledTimes(1);
      const setupAt = runSetupMock.mock.invocationCallOrder[0] as number;
      const reads = cmds()
        .map((c, i) => ({ at: execMock.mock.invocationCallOrder[i] as number, c }))
        .filter(({ c }) => (c as string).includes('rev-parse --verify'));
      // Both of the guard's reads (HEAD, origin/<default>) precede the setup command.
      expect(reads.filter(({ at }) => at < setupAt).length).toBeGreaterThanOrEqual(2);
      expect(
        reads.filter(({ at }) => at > setupAt).every(({ c }) => !(c as string).includes('origin/'))
      ).toBe(true);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('starts the session at the work branch tip (after the sync), and carries the original base forward', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const base = stage('a.ts\0');
    try {
      const result = await runImplementerFixSession(
        input({
          allowedPaths: ['a.ts'],
          previousCodeResult: codeResult({ baseSha: 'c'.repeat(40), repoId: 'repo-1' }),
        })
      );
      const all = cmds();
      const reset = all.findIndex((c) => c.includes('reset --hard origin/'));
      const startHead = all.findIndex((c) => c.includes("rev-parse --verify 'HEAD^{commit}'"));
      expect(reset).toBeGreaterThanOrEqual(0);
      expect(startHead).toBeGreaterThan(reset);
      // The whole change is reported against the original run's base, as two trees.
      expect(
        all.some((c) => c.includes(' --text ') && c.includes(`'${'c'.repeat(40)}' '${BASE}'`))
      ).toBe(true);
      expect(result.baseSha).toBe('c'.repeat(40));
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('commits, pushes and reports the same pinned way when the step sets no list', async () => {
    findRepo.mockResolvedValue(REPO as never);
    // The test-integrity guard has its own describe below; off, only the path guard's pinning applies.
    vi.mocked(resolveSetting).mockImplementation((async (key: string) =>
      key === 'github.ciFixTestIntegrityGuard' ? 'off' : 'mastra') as never);
    const result = await runImplementerFixSession(input());
    vi.mocked(resolveSetting).mockImplementation((async () => 'mastra') as never);
    // Hooks off, never the plain `git commit`.
    expect(cmds().some((c) => c.includes('commit --no-verify'))).toBe(true);
    expect(cmds().some((c) => c.includes('git commit -m'))).toBe(false);
    // The pushed commit is the one reported, and the diff is the fork point read before the
    // agent ran (the default tip here) against it: two distinct shas.
    const head = 'e'.repeat(40);
    expect(
      gitAuthedMock.mock.calls.some((c) =>
        (c[0] as string).includes(`push origin ${head}:refs/heads/'auto/T-1'`)
      )
    ).toBe(true);
    expect(result.headSha).toBe(head);
    expect(
      cmds().some((c) => c.includes(' --text ') && c.includes(`'${DEFAULT_TIP}' '${head}'`))
    ).toBe(true);
  });
});

describe('runImplementerFixSession', () => {
  it('refuses an unpriced model before any workspace exists, for the role it runs as', async () => {
    assertRolePricedMock.mockRejectedValueOnce(unpriced());
    await expect(runImplementerFixSession(input())).rejects.toMatchObject({
      type: 'MODEL_UNPRICED',
    });
    expect(assertRolePricedMock).toHaveBeenCalledWith(input().agentKey);
    expect(findRepo).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('resolves the repo from CodeResult.repoId without a branch lookup', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(input());
    // The installation must be selected, not merely allowed to be: a fix
    // session that resolved its repo without one clones through the default
    // installation, which 404s for a repo in another GitHub organization.
    expect(findRepo).toHaveBeenCalledWith({
      include: { installation: { select: { host: true, installationId: true } } },
      where: { id: 'repo-1' },
    });
    expect(findWorkflow).not.toHaveBeenCalled();
    expect(out.repoId).toBe('repo-1');
    expect(out.headSha).toBe('e'.repeat(40));
  });

  it('falls back to the legacy branch lookup for old context snapshots', async () => {
    findWorkflow.mockResolvedValue({ repository: REPO } as never);
    const out = await runImplementerFixSession(
      input({ previousCodeResult: codeResult({ repoId: undefined }) })
    );
    expect(findWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assignedBranch: 'auto/T-1' } })
    );
    expect(out.repoId).toBe('repo-1');
  });

  it('throws when neither repoId nor a branch-matched workflow exists', async () => {
    findWorkflow.mockResolvedValue(null as never);
    await expect(
      runImplementerFixSession(input({ previousCodeResult: codeResult({ repoId: undefined }) }))
    ).rejects.toThrow(/No workflow found for branch/);
  });

  it('runs both diff scanners on the pushed result (scan parity with the initial path)', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    expect(scanDiffForCodeIssuesMock).toHaveBeenCalledWith('diff --git a/x b/x');
    expect(scanDiffForSecurityIssuesMock).toHaveBeenCalledWith('diff --git a/x b/x');
  });

  it('throws SECURITY_GATE_FAILURE on critical security findings', async () => {
    findRepo.mockResolvedValue(REPO as never);
    scanDiffForSecurityIssuesMock.mockResolvedValueOnce({
      findings: [
        { category: 'SECRET', description: 'hardcoded key', file: 'a.ts', severity: 'CRITICAL' },
      ],
      passed: false,
    } as never);
    await expect(runImplementerFixSession(input())).rejects.toMatchObject({
      type: 'SECURITY_GATE_FAILURE',
    });
    // Trace persisted and workspace destroyed despite the throw.
    expect(persistMock).toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalled();
  });

  it('fails non-retryable when the security gate itself errors after the push', async () => {
    findRepo.mockResolvedValue(REPO as never);
    scanDiffForSecurityIssuesMock.mockRejectedValueOnce(new Error('provider 500'));
    await expect(runImplementerFixSession(input())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'SECURITY_GATE_UNAVAILABLE',
    });
  });

  it('persists the trace and destroys the workspace when the agent throws', async () => {
    findRepo.mockResolvedValue(REPO as never);
    generateMock.mockRejectedValueOnce(new Error('LLM exploded'));
    await expect(runImplementerFixSession(input())).rejects.toThrow('LLM exploded');
    expect(persistMock).toHaveBeenCalledWith(expect.anything(), 'ciFixer');
    expect(destroyMock).toHaveBeenCalled();
  });

  it('persists its start event even when the agent throws', async () => {
    findRepo.mockResolvedValue(REPO as never);
    generateMock.mockRejectedValueOnce(new Error('LLM exploded'));
    const startEvent = { name: 'ci_fix.failure_logs', outputJson: { logTail: 'FAIL a.test.ts' } };
    await expect(runImplementerFixSession(input({ startEvent }))).rejects.toThrow('LLM exploded');
    const tracer = persistMock.mock.calls[0]?.[0] as {
      records: Array<{ toolName?: string; outputJson?: unknown; seq: number }>;
    };
    expect(tracer.records[0]).toMatchObject({
      outputJson: { logTail: 'FAIL a.test.ts' },
      seq: 0,
      toolName: 'ci_fix.failure_logs',
    });
  });

  it('syncs the workspace to the remote branch before the agent runs', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    const commands = execMock.mock.calls.map((c) => c[0]);
    // fetch now goes through gitAuthed (credential injected per-call rather
    // than a plain `git fetch`), so match on the subcommand rather than a
    // literal `git fetch` prefix.
    // An explicit refspec: the clone is single-branch, so a bare branch name
    // would never create the origin/<branch> the reset below needs.
    const fetch = commands.find((c) => c.includes('fetch origin'));
    expect(fetch).toMatch(/'\+refs\/heads\/(\S+):refs\/remotes\/origin\/\1'/);
    expect(commands.some((c) => c.startsWith('git reset --hard origin/'))).toBe(true);
  });

  it('degrades the advisory code-security scan instead of failing the fix', async () => {
    findRepo.mockResolvedValue(REPO as never);
    scanDiffForCodeIssuesMock.mockRejectedValueOnce(new Error('pattern db down'));
    const out = await runImplementerFixSession(input());
    expect(out.codeSecurityFindings).toBeUndefined();
    expect(out.headSha).toBe('e'.repeat(40));
  });

  it('gives the test run the long timeout instead of the 2-minute exec default', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    const testCall = execMock.mock.calls.find((c) => c[1]?.timeoutMs === 600_000);
    expect(testCall).toBeDefined();
  });

  it('shell-quotes the repository defaultBranch in the diff command', async () => {
    findRepo.mockResolvedValue({ ...REPO, defaultBranch: 'main; touch /pwned' } as never);
    await runImplementerFixSession(input());
    const commands = execMock.mock.calls.map((c) => c[0]);
    expect(commands.some((c) => c.includes("'origin/main; touch /pwned^{commit}'"))).toBe(true);
    expect(commands.some((c) => c.includes(' origin/main; touch /pwned'))).toBe(false);
  });

  it('clones and diffs against the branch the change was cut from, and carries it forward', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const { createWorkspace } = await import('./workspace.js');
    const out = await runImplementerFixSession(
      input({ previousCodeResult: codeResult({ baseBranch: 'release/1.4', repoId: 'repo-1' }) })
    );
    expect(vi.mocked(createWorkspace).mock.calls.at(-1)?.[2]).toBe('release/1.4');
    expect(
      execMock.mock.calls.some((c) => String(c[0]).includes("'origin/release/1.4^{commit}'"))
    ).toBe(true);
    expect(out.baseBranch).toBe('release/1.4');
  });

  it('returns no base for a result recorded before the field existed', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(input());
    expect(out).not.toHaveProperty('baseBranch');
  });

  it('feeds the afterGenerate note into the implementation notes', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(
      input({ afterGenerate: async () => 'runTests passing' })
    );
    expect(out.implementationNotes).toBe('notes(true, runTests passing)');
  });

  it("runs as its own persona: the persona's prompt, tools and model, not the implementer's", async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    // The session's repository binds the read-only memory tools.
    expect(buildImplementerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'ciFixer',
      'repo-1',
      expect.anything()
    );
    const messages = generateMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system')?.content;
    expect(system).toBe('CI FIXER ROW PROMPT');
    expect(recordLlmUsageMock).toHaveBeenCalledWith(
      'wf-1',
      'ciFixer',
      expect.anything(),
      'llm.ci_fix',
      // Priced at the spec the session bound, not re-resolved per turn.
      'anthropic/v4-model'
    );
  });

  it('stamps the trace row with the Agent row whose model it priced, even if a newer version is cut', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const addLlmResponse = vi.spyOn(AgentTracer.prototype, 'addLlmResponse');
    // The session's one resolution is v3; any later resolution would return v4.
    getBoundModelMock.mockResolvedValueOnce({
      agent: { id: 'agent-row-3', version: 3 },
      model: {},
      spec: 'anthropic/v3-model',
      systemPrompt: null,
    });
    await runImplementerFixSession(input());
    expect(recordLlmUsageMock).toHaveBeenLastCalledWith(
      'wf-1',
      'ciFixer',
      expect.anything(),
      'llm.ci_fix',
      'anthropic/v3-model'
    );
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { id: 'agent-row-3', version: 3 } })
    );
  });

  it('prefers a step-level prompt override over the persona row', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input({ systemPromptOverride: 'STEP OVERRIDE' }));
    const messages = generateMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages.find((m) => m.role === 'system')?.content).toBe('STEP OVERRIDE');
  });

  it('passes the resolved step budget to generate', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    expect(generateMock.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 42, toolChoice: 'auto' });
  });

  it("runs the repo's configured test command instead of guessing from package.json", async () => {
    findRepo.mockResolvedValue({ ...REPO, gateCommands: { runTests: 'pytest -q' } } as never);
    await runImplementerFixSession(input());
    const testCall = execMock.mock.calls.find((c) => c[1]?.timeoutMs === 600_000);
    expect(testCall?.[0]).toBe('{ pytest -q\n} 2>&1');
  });

  describe('a stack command that finds no tests', () => {
    const python = { components: [{ path: '', stacks: ['python'] }], evidence: [] };
    const notesSentence =
      'The test command `python -m pytest` found no tests to run; set `runTests` for this repository.';

    const base = execMock.getMockImplementation();
    afterEach(() => {
      execMock.mockImplementation(base as never);
    });

    /** Make the test run (and only it) reject like a failed `docker exec`. */
    function testRunRejects(fields: Record<string, unknown>) {
      execMock.mockImplementation((async (cmd: string, options?: { timeoutMs?: number }) => {
        if (options?.timeoutMs === 600_000) {
          throw Object.assign(new Error('Command failed'), fields);
        }
        return base?.(cmd, options);
      }) as never);
    }

    it('records tdd.no_tests_found, reports not run, and says so in the notes', async () => {
      const eventSpy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
      findRepo.mockResolvedValue({ ...REPO, detectedStack: python, executorImage: 'img' } as never);
      testRunRejects({ code: 5, stdout: 'no tests ran' });
      const out = await runImplementerFixSession(input());
      const events = eventSpy.mock.calls
        .map(([e]) => e)
        .filter((e) => e.name === 'tdd.no_tests_found');
      expect(events).toHaveLength(1);
      expect(events[0].outputJson).toEqual({
        command: 'python -m pytest',
        output: 'no tests ran',
        reason: 'exit status 5: no tests ran',
      });
      expect(out.testResults).toMatchObject({ failing: 0, passed: false, total: 0 });
      expect(out.implementationNotes).toContain(notesSentence);
      expect(out.implementationNotes).toContain('notes(false)');
    });

    it('words a zero exit with no counts neutrally, with its own event and no loop wording', async () => {
      const eventSpy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
      findRepo.mockResolvedValue({
        ...REPO,
        detectedStack: { components: [{ path: '', stacks: ['jvm'] }], evidence: [] },
        executorImage: 'img',
      } as never);
      execMock.mockImplementation((async (cmd: string, options?: { timeoutMs?: number }) =>
        options?.timeoutMs === 600_000 ? '' : base?.(cmd, options)) as never);
      const out = await runImplementerFixSession(input());
      expect(eventSpy.mock.calls.filter(([e]) => e.name === 'tdd.tests_unreadable')).toHaveLength(
        1
      );
      expect(out.implementationNotes).toContain(
        ' exited 0 but printed no test counts, so whether tests ran could not be determined. Set `runTests`'
      );
      expect(out.implementationNotes).not.toContain('loop');
    });

    it('treats the same exit from a configured command as an ordinary failure', async () => {
      const eventSpy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
      findRepo.mockResolvedValue({
        ...REPO,
        detectedStack: python,
        executorImage: 'img',
        gateCommands: { runTests: 'pytest -q' },
      } as never);
      testRunRejects({ code: 5, stdout: 'no tests ran' });
      const out = await runImplementerFixSession(input());
      expect(eventSpy.mock.calls.filter(([e]) => e.name === 'tdd.no_tests_found')).toHaveLength(0);
      expect(out.testResults).toMatchObject({ failing: 1, passed: false });
      expect(out.implementationNotes).toBe('notes(false)');
    });
  });

  it('swallows afterGenerate failures (informational hook)', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(
      input({
        afterGenerate: async () => {
          throw new Error('rerun blew up');
        },
      })
    );
    expect(out.implementationNotes).toBe('notes(true)');
  });
});

describe('runImplementerFixSession test-integrity guard', () => {
  const START = 'a'.repeat(40);
  const DELETES_TEST = [
    'diff --git a/src/a.test.ts b/src/a.test.ts',
    'deleted file mode 100644',
    '--- a/src/a.test.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    "-it('adds', () => {",
    '-  expect(add(1, 2)).toBe(3);',
    '',
  ].join('\n');
  const GUARD_DIFF = ' --text -U1 ';
  const cmds = () => execMock.mock.calls.map((c) => c[0]);

  /** The exec the gate sees: a readable starting sha and the given committed diff. */
  function stageCommittedDiff(diff: string, head: string = START) {
    const base = execMock.getMockImplementation();
    execMock.mockImplementation((async (cmd: string, options?: { timeoutMs?: number }) => {
      if (cmd.includes('rev-parse --verify')) {
        return `${cmd.includes('origin/') ? DEFAULT_TIP : head}\n`;
      }
      return cmd.includes(GUARD_DIFF) ? withEndMarker(cmd, diff) : base?.(cmd, options);
    }) as never);
    return base;
  }

  function guardSetting(value: string) {
    vi.mocked(resolveSetting).mockImplementation((async (key: string) =>
      key === 'github.ciFixTestIntegrityGuard' ? value : 'mastra') as never);
  }

  afterEach(() => {
    vi.mocked(resolveSetting).mockImplementation((async () => 'mastra') as never);
  });

  it('blocks a CI fix that deletes a test: committed without hooks, analysed, never pushed', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('block');
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await expect(runImplementerFixSession(input())).rejects.toMatchObject({
        nonRetryable: true,
        type: 'TEST_INTEGRITY_GUARD',
      });
      expect(cmds().some((c) => c.includes('push origin'))).toBe(false);
      // The commit has hooks off, and the diff is read between the starting commit and the
      // committed sha, both quoted.
      expect(cmds().some((c) => c.includes('commit --no-verify'))).toBe(true);
      expect(cmds().some((c) => c.includes(`${GUARD_DIFF}'${START}' '${START}'`))).toBe(true);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('treats an unrecognised setting value as the default (warn), not off', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('banana');
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await runImplementerFixSession(input());
      expect(cmds().some((c) => c.includes(GUARD_DIFF))).toBe(true);
      expect(cmds().some((c) => c.includes('push origin'))).toBe(true);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('pushes the analysed commit by sha in warn mode and records the trip as not blocked', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('warn');
    const events: Array<{ name: string; outputJson?: Record<string, unknown> }> = [];
    vi.spyOn(AgentTracer.prototype, 'addActivityEvent').mockImplementation((opts) => {
      events.push(opts as never);
    });
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await runImplementerFixSession(input());
      // Pushed by sha, so a branch the agent moved cannot ride along.
      expect(cmds().some((c) => c.includes(`push origin ${START}:refs/heads/'auto/T-1'`))).toBe(
        true
      );
      const trip = events.find((e) => e.name === 'ci_fix.test_integrity_guard');
      expect(trip?.outputJson).toMatchObject({ blocked: false, mode: 'warn' });
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('commits without hooks but reads no test-integrity diff when off', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('off');
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await runImplementerFixSession(input());
      expect(cmds().some((c) => c.includes(GUARD_DIFF))).toBe(false);
      expect(cmds().some((c) => c.includes('commit --no-verify'))).toBe(true);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('does not apply to a review fix', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('block');
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await runImplementerFixSession(input({ agentKey: 'reviewFixer', mode: 'REVIEW_FIX' }));
      expect(cmds().some((c) => c.includes(GUARD_DIFF))).toBe(false);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it.each([
    ['gateFixer', 'GATE_FIX'],
    ['reviewFixer', 'PR_FEEDBACK'],
  ] as const)('covers the %s %s session too', async (agentKey, mode) => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('block');
    const base = stageCommittedDiff(DELETES_TEST);
    try {
      await expect(runImplementerFixSession(input({ agentKey, mode }))).rejects.toMatchObject({
        type: 'TEST_INTEGRITY_GUARD',
      });
      expect(cmds().some((c) => c.includes('push origin'))).toBe(false);
    } finally {
      execMock.mockImplementation(base as never);
    }
  });

  it('fails closed before the paid session when the starting commit is unreadable in block mode', async () => {
    findRepo.mockResolvedValue(REPO as never);
    guardSetting('block');
    // An exec that answers rev-parse with a value that is not a sha.
    const base = execMock.getMockImplementation();
    execMock.mockImplementation((async (cmd: string, options?: { timeoutMs?: number }) =>
      cmd.includes('rev-parse --verify') ? 'abc123\n' : base?.(cmd, options)) as never);
    try {
      await expect(runImplementerFixSession(input())).rejects.toMatchObject({
        nonRetryable: true,
        type: 'TEST_INTEGRITY_GUARD_UNAVAILABLE',
      });
    } finally {
      execMock.mockImplementation(base as never);
    }
    expect(generateMock).not.toHaveBeenCalled();
    expect(cmds().some((c) => c.includes('push origin'))).toBe(false);
  });

  it('resolves the setting before the workspace exists, so a failing lookup costs nothing', async () => {
    findRepo.mockResolvedValue(REPO as never);
    vi.mocked(resolveSetting).mockImplementation((async (key: string) => {
      if (key === 'github.ciFixTestIntegrityGuard') {
        throw new Error('config store down');
      }
      return 'mastra';
    }) as never);
    await expect(runImplementerFixSession(input())).rejects.toThrow('config store down');
    expect(execMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('runImplementerFixSession ask and resume', () => {
  const runTurn = vi.fn();
  const closeRunner = vi.fn(async () => {});
  const fakeRunner = {
    agent: { id: 'agent-row-4', version: 4 },
    boundModelSpec: 'anthropic/v4-model',
    close: closeRunner,
    kind: 'claude-code',
    kindSource: 'default',
    maxSteps: 50,
    promptSuffix: '',
    runtime: { runTurn },
    skills: [],
    systemPrompt: (base: string) => base,
    toolKeys: null,
  };
  const surface = (extra: Record<string, unknown> = {}) => ({
    agentKey: 'ciFixer',
    branch: 'auto/T-1',
    kind: 'implementerSession',
    ...extra,
  });
  const commands = () => execMock.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    findRepo.mockResolvedValue(REPO as never);
    runTurn.mockReset();
    runTurn.mockResolvedValue({ text: 'fixed', toolCallCount: 0 });
    vi.mocked(buildImplementerTurnRunner).mockResolvedValue(fakeRunner as never);
  });
  afterEach(() => {
    vi.mocked(buildImplementerTurnRunner).mockReset();
  });

  it('runs unattended by default', async () => {
    const out = await runImplementerFixSession(input());
    expect(vi.mocked(buildImplementerTurnRunner).mock.calls[0]?.[0]).not.toHaveProperty(
      'allowPause'
    );
    expect(out.headSha).toBeDefined();
    expect(snapshotWorkingTree).not.toHaveBeenCalled();
    expect(restoreWorkingTree).not.toHaveBeenCalled();
  });

  it('asks the runner to allow pausing when the input says so', async () => {
    await runImplementerFixSession({ ...input(), allowPause: true });
    expect(vi.mocked(buildImplementerTurnRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ agentKey: 'ciFixer', allowPause: true })
    );
  });

  it('stops at a question: no gate re-run, tests, commit, push or scan', async () => {
    runTurn.mockResolvedValueOnce({ needsInput: QUESTIONS, text: 'which db?', toolCallCount: 0 });
    const afterGenerate = vi.fn(async () => 'rerun');
    const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

    const result = await runImplementerFixSession({
      ...input({ afterGenerate }),
      allowPause: true,
    });

    expect(result).toMatchObject({
      needsInput: {
        questions: QUESTIONS,
        resume: {
          snapshot: { artifactId: 'art-9' },
          surface: { agentKey: 'ciFixer', branch: 'auto/T-1', kind: 'implementerSession' },
        },
      },
    });
    // Saved against the commit the checkout was at when the session began, not a later HEAD.
    expect(snapshotWorkingTree).toHaveBeenCalledWith(expect.anything(), {
      runId: 'run-1',
      startSha: 'abc123',
    });
    expect(afterGenerate).not.toHaveBeenCalled();
    expect(execMock.mock.calls.filter((c) => c[1]?.timeoutMs === 600_000)).toHaveLength(0);
    expect(commands()).not.toContain('git add -A');
    // No `git commit`. A read-only `rev-parse HEAD^{commit}` (the guard's start read) names the
    // word without committing, so match the subcommand, not the substring.
    expect(commands().some((c) => /\bgit\b[^|;&]*\scommit(\s|$)/.test(c))).toBe(false);
    expect(gitAuthedMock).not.toHaveBeenCalledWith(expect.stringContaining('push origin'));
    expect(pushEffect).not.toHaveBeenCalled();
    expect(scanDiffForCodeIssuesMock).not.toHaveBeenCalled();
    expect(scanDiffForSecurityIssuesMock).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith({
      name: 'agent.paused',
      outputJson: { questions: 1, snapshotBytes: 321, surface: 'implementerSession' },
    });
    expect(closeRunner).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledTimes(1);
    events.mockRestore();
  });

  it('restores the tree before the first turn and puts the answers in its message', async () => {
    await runImplementerFixSession({
      ...input(),
      allowPause: true,
      resumeInput: resumeInputFor(surface()),
    });

    expect(restoreWorkingTree).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'workspace-test' }),
      expect.objectContaining({ artifactId: 'art-1' })
    );
    expect(vi.mocked(restoreWorkingTree).mock.invocationCallOrder[0]).toBeLessThan(
      runTurn.mock.invocationCallOrder[0] ?? 0
    );
    // Cut from the commit the tree was saved against; the sync to the remote branch tip is
    // skipped, because moving off that commit would stop the patch applying.
    const { createWorkspace } = await import('./workspace.js');
    expect(vi.mocked(createWorkspace).mock.calls.at(-1)?.[4]).toBe('a'.repeat(40));
    expect(commands().some((c) => c.includes('reset --hard origin/'))).toBe(false);
    // The only fetch is the one before the push (the branch may have moved while it waited),
    // never a sync before the turn.
    const fetches = gitAuthedMock.mock.calls.filter(([c]) => c.includes('fetch origin'));
    expect(fetches).toHaveLength(1);
    const fetchOrder = gitAuthedMock.mock.invocationCallOrder[
      gitAuthedMock.mock.calls.findIndex(([c]) => c.includes('fetch origin'))
    ] as number;
    expect(fetchOrder).toBeGreaterThan(runTurn.mock.invocationCallOrder[0] ?? Infinity);
    const user = runTurn.mock.calls[0]?.[0].user as string;
    expect(user).toContain('"mode":"CI_FIX"');
    expect(user).toContain('[answers: begin]');
    expect(user).toContain('| Postgres');
    // The fix still ends in the normal commit and push.
    expect(commands()).toContain('git add -A');
  });

  it('replays a resumed session on top of a branch that moved while it waited, before the push', async () => {
    execMock.mockImplementation((async (cmd: string) => {
      if (cmd.includes('merge-base --is-ancestor')) {
        return 'rc=1\n';
      }
      return cmd.includes('rev-parse') ? '1234567890123456789012345678901234567890\n' : '';
    }) as never);
    await runImplementerFixSession({
      ...input(),
      allowPause: true,
      resumeInput: resumeInputFor(surface()),
    });
    const all = commands();
    // Rebased onto the commit id of the fetched ref, never onto a name the agent could shadow.
    const rebase = all.findIndex(
      (c) => c.includes('rebase') && c.includes('1234567890123456789012345678901234567890')
    );
    const push = all.findIndex((c) => c.includes('push origin'));
    expect(rebase).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(rebase);
  });

  it('fails a resumed session non-retryably, pushing nothing, when the moved branch conflicts', async () => {
    execMock.mockImplementation((async (cmd: string) => {
      if (cmd.includes('merge-base --is-ancestor')) {
        return 'rc=1\n';
      }
      if (cmd.includes('ls-files -u')) {
        return 'U\n';
      }
      if (cmd.includes('rebase') && !cmd.includes('--abort')) {
        throw new Error('CONFLICT');
      }
      return cmd.includes('rev-parse') ? '1234567890123456789012345678901234567890\n' : '';
    }) as never);
    const failure = await runImplementerFixSession({
      ...input(),
      allowPause: true,
      resumeInput: resumeInputFor(surface()),
    }).catch((e) => e);
    expect(failure).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_PUSH_CONFLICT' });
    expect(commands().some((c) => c.includes('rebase --abort'))).toBe(true);
    expect(commands().some((c) => c.includes('push origin'))).toBe(false);
  });

  it.each([
    ['another surface', surface({ kind: 'executeImplementation' })],
    ['another persona', surface({ agentKey: 'reviewFixer' })],
    ['another branch', surface({ branch: 'auto/OTHER-1' })],
  ])('refuses a state from %s before cloning, without retrying', async (_name, state) => {
    const failure = await runImplementerFixSession({
      ...input(),
      resumeInput: resumeInputFor(state),
    }).catch((err: unknown) => err);

    expect(failure).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_RESTORE_FAILED' });
    expect(runTurn).not.toHaveBeenCalled();
    expect(findRepo).not.toHaveBeenCalled();
  });
});

// A failing assertion must not leak a spy on AgentTracer into the next test.
afterEach(() => {
  vi.restoreAllMocks();
});
