import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the cross-repo dependency block reaching the implementer's system
 * prompt (repo dependency graph, P2). Everything the activity touches outside
 * that path — workspace, agent, git, scanners — is faked; the assertion is on
 * the `system` message the implementer agent is generated with.
 */

const { checkoutMock, generateMock, loadMock, prismaMock, workspaceMock } = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  generateMock: vi.fn(),
  loadMock: vi.fn(),
  prismaMock: {
    connection: { findUniqueOrThrow: vi.fn() },
    contextSnapshot: { findUnique: vi.fn() },
    workflowRun: { update: vi.fn() },
  },
  workspaceMock: {
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async () => ''),
    execCapture: vi.fn(),
    gitAuthed: vi.fn(async () => ''),
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: prismaMock }));

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => ({})),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    lessonRetrievalLimit: 5,
    lessonRetrievalThreshold: 0.7,
    maxTddIterations: 1,
  })),
}));

vi.mock('@auto-swe/shared/lib/trackerSync', () => ({ syncTrackerOnEvent: vi.fn(async () => {}) }));

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
  heartbeat: vi.fn(),
}));

vi.mock('../agents/implementer.js', () => ({
  buildImplementerForActivity: vi.fn(async () => ({
    agent: { generate: generateMock },
    closeMcp: undefined,
    promptSuffix: '',
    skills: [],
  })),
}));

vi.mock('../agents/securityReviewProcessor.js', () => ({
  scanDiffForSecurityIssues: vi.fn(async () => ({ findings: [], passed: true })),
}));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn(() => 'wf-1'),
  persistActivityTrace: vi.fn(async () => {}),
}));

vi.mock('../lib/codeSecurityScanner.js', () => ({ scanDiffForCodeIssues: vi.fn(async () => []) }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));

vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi
    .fn()
    .mockResolvedValue({ costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 }),
}));

vi.mock('../lib/lessonRetrieval.js', () => ({ retrieveSimilarLessons: vi.fn(async () => []) }));

vi.mock('../lib/models.js', () => ({ resolveSystemPrompt: vi.fn(async () => 'BASE_PROMPT') }));

vi.mock('../lib/repoDependencyContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/repoDependencyContext.js')>();
  return { ...actual, checkoutUpstreamRepos: checkoutMock, loadRepoDependencyContext: loadMock };
});

vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: vi.fn(async () => ({ authedCloneUrl: 'https://x:t@github.com/a/b.git' })),
  }),
  toRepoRef: (r: unknown) => r,
}));

vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(async () => workspaceMock),
  shellQuote: (s: string) => `'${s}'`,
}));

import { executeImplementation } from './executeImplementation.js';

const REQUEST: RepoWorkRequest = {
  description: 'Add a health endpoint',
  externalTicketId: 'JIRA-1',
  repoId: 'repo-1',
} as RepoWorkRequest;

/** The `system` message the implementer agent was generated with. */
function systemPrompt(): string {
  const messages = generateMock.mock.calls[0][0] as { content: string; role: string }[];
  return messages.find((m) => m.role === 'system')?.content ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  loadMock.mockResolvedValue('');
  checkoutMock.mockResolvedValue('');
  generateMock.mockResolvedValue({ text: 'done', usage: { inputTokens: 1, outputTokens: 1 } });
  prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
    defaultBranch: 'main',
    executorImage: null,
    id: 'repo-1',
    organizationName: 'acme',
    repoName: 'api',
  });
  prismaMock.contextSnapshot.findUnique.mockResolvedValue(null);
  prismaMock.workflowRun.update.mockResolvedValue({});
  workspaceMock.exec.mockResolvedValue('');
});

describe('executeImplementation cross-repo context', () => {
  it('appends the dependency block to the implementer system prompt', async () => {
    loadMock.mockResolvedValue('\n\n## Cross-Repo Dependency Context\n- acme/web — kinds: code');

    await executeImplementation(REQUEST);

    expect(loadMock).toHaveBeenCalledWith('repo-1', 'org-1');
    const prompt = systemPrompt();
    expect(prompt.startsWith('BASE_PROMPT')).toBe(true);
    expect(prompt).toContain('## Cross-Repo Dependency Context');
    expect(prompt).toContain('- acme/web — kinds: code');
  });

  it('leaves the prompt unchanged when the graph is empty', async () => {
    await executeImplementation(REQUEST);
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('skips the graph read when the step opts out', async () => {
    await executeImplementation(REQUEST, undefined, undefined, { crossRepoContext: false });
    expect(loadMock).not.toHaveBeenCalled();
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('does not check out upstream repos by default', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    await executeImplementation(REQUEST);
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it('checks out upstream repos when the expensive tier is enabled', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    checkoutMock.mockResolvedValue('\n\n### Upstream sources checked out locally\n- a → `/x`');

    await executeImplementation(REQUEST, undefined, undefined, { crossRepoCheckout: true });

    expect(checkoutMock).toHaveBeenCalledWith(workspaceMock, 'repo-1', 'org-1');
    expect(systemPrompt()).toContain('Upstream sources checked out locally');
  });

  it('never fails the run when the graph read throws', async () => {
    loadMock.mockRejectedValue(new Error('db down'));
    await expect(executeImplementation(REQUEST)).resolves.toMatchObject({ repoId: 'repo-1' });
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('never fails the run when the dependency checkout throws', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    checkoutMock.mockRejectedValue(new Error('docker gone'));
    await expect(
      executeImplementation(REQUEST, undefined, undefined, { crossRepoCheckout: true })
    ).resolves.toMatchObject({ repoId: 'repo-1' });
  });
});

describe('executeImplementation shell hygiene', () => {
  it('shell-quotes the repository defaultBranch in the diff command', async () => {
    prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
      defaultBranch: 'main; touch /pwned',
      executorImage: null,
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'api',
    });
    await executeImplementation(REQUEST);
    const commands = workspaceMock.exec.mock.calls.map((c) => c[0] as string);
    expect(commands).toContain("git diff origin/'main; touch /pwned'");
    expect(commands).not.toContain('git diff origin/main; touch /pwned');
  });
});
