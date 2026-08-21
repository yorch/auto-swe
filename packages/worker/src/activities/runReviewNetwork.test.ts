import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadMock, runReviewMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  runReviewMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

vi.mock('../agents/reviewNetwork.js', () => ({ runReviewNetwork: runReviewMock }));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowRunId: vi.fn(async () => 'run-1'),
  persistActivityTrace: vi.fn(async () => {}),
}));

vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn(async () => ({ model: { systemPrompt: null }, skills: [] })),
}));

vi.mock('../lib/config/agentSkills.js', () => ({ skillsToPromptSuffix: vi.fn(() => undefined) }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));

vi.mock('../lib/evalCapture.js', () => ({ recordReviewEval: vi.fn(async () => {}) }));

vi.mock('../lib/repoDependencyContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/repoDependencyContext.js')>();
  return { ...actual, loadRepoDependencyContext: loadMock };
});

import { persistActivityTrace } from '../lib/activityContext.js';
import { runReviewNetwork } from './runReviewNetwork.js';

const CODE_RESULT: CodeResult = {
  branch: 'auto/JIRA-1',
  diff: 'd',
  filesChanged: [],
  headSha: 'abc',
  implementationNotes: '',
  repoId: 'repo-1',
  testResults: { duration_ms: 1, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
};

/** Activity events recorded on the tracer that was persisted. */
function persistedEventNames(): string[] {
  const tracer = vi.mocked(persistActivityTrace).mock.calls.at(-1)?.[0] as unknown as {
    records: { type: string; toolName?: string | null }[];
  };
  return (tracer?.records ?? [])
    .filter((r) => r.type === 'activity_event')
    .map((r) => r.toolName ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  loadMock.mockResolvedValue('');
  runReviewMock.mockResolvedValue({ approved: true, codeResult: CODE_RESULT, verdicts: [] });
});

describe('runReviewNetwork activity', () => {
  it('loads the dependency graph for the code result repo in the run org', async () => {
    await runReviewNetwork(CODE_RESULT);
    expect(loadMock).toHaveBeenCalledWith('repo-1', 'org-1');
  });

  it('passes the block to the review network as the trailing argument', async () => {
    loadMock.mockResolvedValue('\n\n## Cross-Repo Dependency Context\n- acme/api');
    await runReviewNetwork(CODE_RESULT);
    expect(runReviewMock.mock.calls[0][7]).toContain('## Cross-Repo Dependency Context');
  });

  it('passes undefined rather than an empty string when the graph is empty', async () => {
    await runReviewNetwork(CODE_RESULT);
    expect(runReviewMock.mock.calls[0][7]).toBeUndefined();
  });

  it('records a tracer event when a block is injected', async () => {
    loadMock.mockResolvedValue('BLOCK');
    await runReviewNetwork(CODE_RESULT);
    expect(persistedEventNames()).toContain('crossRepo.context_loaded');
  });

  it('records no event when there is nothing to inject', async () => {
    await runReviewNetwork(CODE_RESULT);
    expect(persistedEventNames()).not.toContain('crossRepo.context_loaded');
  });

  it('skips the graph read entirely when the step opts out', async () => {
    await runReviewNetwork(CODE_RESULT, undefined, undefined, { crossRepoContext: false });
    expect(loadMock).not.toHaveBeenCalled();
    expect(runReviewMock.mock.calls[0][7]).toBeUndefined();
  });
});
