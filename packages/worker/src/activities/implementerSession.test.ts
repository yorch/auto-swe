import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    repository: { findUniqueOrThrow: vi.fn() },
  },
}));

// heartbeat() throws outside a real activity context; keep ApplicationFailure real.
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: () => {},
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

vi.mock('../lib/githubAuth.js', () => ({
  requireGitHubToken: vi.fn(async () => 'tok'),
}));

const execMock = vi.fn(async (cmd: string) => {
  if (cmd.includes('rev-parse')) {
    return 'abc123\n';
  }
  if (cmd.startsWith('git diff origin/')) {
    return 'diff --git a/x b/x';
  }
  if (cmd.includes('cat package.json')) {
    return '{}';
  }
  return '';
});
const destroyMock = vi.fn(async () => {});
vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(async () => ({
    containerId: 'workspace-test',
    destroy: destroyMock,
    exec: execMock,
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
  })),
  shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
}));

const generateMock = vi.fn(async () => ({
  text: 'fixed it',
  usage: { inputTokens: 10, outputTokens: 5 },
}));
vi.mock('../agents/implementer.js', () => ({
  createImplementerAgent: vi.fn(async () => ({
    agent: { generate: generateMock },
    promptSuffix: '',
  })),
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
  persistActivityTrace: (...args: unknown[]) => persistMock(...args),
}));

vi.mock('../lib/costTracking.js', () => ({
  recordLlmUsage: vi.fn(async () => {}),
}));

vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn(async () => []),
  loadAgentToolConfig: vi.fn(async () => null),
}));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));

vi.mock('../lib/models.js', () => ({
  resolveSystemPrompt: vi.fn(async (_role: string, fallback: string) => fallback),
}));

import { prisma } from '@auto-swe/shared/db';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { runImplementerFixSession } from './implementerSession.js';

const findRepo = vi.mocked(prisma.repository.findUniqueOrThrow);
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

function input(overrides: Partial<Parameters<typeof runImplementerFixSession>[0]> = {}) {
  return {
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

describe('runImplementerFixSession', () => {
  it('resolves the repo from CodeResult.repoId without a branch lookup', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(input());
    expect(findRepo).toHaveBeenCalledWith({ where: { id: 'repo-1' } });
    expect(findWorkflow).not.toHaveBeenCalled();
    expect(out.repoId).toBe('repo-1');
    expect(out.headSha).toBe('abc123');
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

  it('persists the trace and destroys the workspace when the agent throws', async () => {
    findRepo.mockResolvedValue(REPO as never);
    generateMock.mockRejectedValueOnce(new Error('LLM exploded'));
    await expect(runImplementerFixSession(input())).rejects.toThrow('LLM exploded');
    expect(persistMock).toHaveBeenCalledWith(expect.anything(), 'implementer');
    expect(destroyMock).toHaveBeenCalled();
  });

  it('syncs the workspace to the remote branch before the agent runs', async () => {
    findRepo.mockResolvedValue(REPO as never);
    await runImplementerFixSession(input());
    const commands = execMock.mock.calls.map((c) => c[0]);
    expect(commands.some((c) => c.startsWith('git fetch origin'))).toBe(true);
    expect(commands.some((c) => c.startsWith('git reset --hard origin/'))).toBe(true);
  });

  it('feeds the afterGenerate note into the implementation notes', async () => {
    findRepo.mockResolvedValue(REPO as never);
    const out = await runImplementerFixSession(
      input({ afterGenerate: async () => 'runTests passing' })
    );
    expect(out.implementationNotes).toBe('notes(false, runTests passing)');
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
    expect(out.implementationNotes).toBe('notes(false)');
  });
});
