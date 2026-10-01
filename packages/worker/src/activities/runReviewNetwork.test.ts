import {
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  SECURITY_AUDITOR_PROMPT,
} from '@auto-swe/shared/lib/agentPrompts';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadMock, runReviewMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  runReviewMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

vi.mock('../agents/reviewNetwork.js', () => ({
  REVIEWER_AGENT_KEYS: {
    DOMAIN_LOGIC: 'domainLogicReviewer',
    PERFORMANCE: 'performanceReviewer',
    SECURITY: 'securityReviewer',
  },
  runReviewNetwork: runReviewMock,
}));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowRunId: vi.fn(async () => 'run-1'),
  persistActivityTrace: vi.fn(async () => {}),
}));

// Mirrors the seeded rows: every persona has its own prompt, and the parent
// `reviewer` row carries the domain-logic prompt. A mock that returned the
// same null prompt for every key could not see the reviewer row's prompt being
// handed to all three personas.
// The texts are the real seeded constants, because "has an admin customised
// this row" is decided by comparing against them.
const SEEDED_REVIEW_PROMPTS: Record<string, string> = {
  domainLogicReviewer: DOMAIN_LOGIC_REVIEWER_PROMPT,
  performanceReviewer: PERFORMANCE_REVIEWER_PROMPT,
  reviewer: DOMAIN_LOGIC_REVIEWER_PROMPT,
  securityReviewer: SECURITY_AUDITOR_PROMPT,
};
let rowPrompts: Record<string, string | undefined> = { ...SEEDED_REVIEW_PROMPTS };
const { resolveAgentMock } = vi.hoisted(() => ({ resolveAgentMock: vi.fn() }));
vi.mock('../lib/config/agentResolver.js', () => ({ resolveAgent: resolveAgentMock }));

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
  rowPrompts = { ...SEEDED_REVIEW_PROMPTS };
  resolveAgentMock.mockImplementation(async (key: string) => ({
    model: { systemPrompt: rowPrompts[key] },
    skills: [],
  }));
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
    expect(runReviewMock.mock.calls[0][1].crossRepoContext).toContain(
      '## Cross-Repo Dependency Context'
    );
  });

  it('passes undefined rather than an empty string when the graph is empty', async () => {
    await runReviewNetwork(CODE_RESULT);
    expect(runReviewMock.mock.calls[0][1].crossRepoContext).toBeUndefined();
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
    expect(runReviewMock.mock.calls[0][1].crossRepoContext).toBeUndefined();
  });

  it("gives each persona its own row's prompt, never the seeded parent reviewer's", async () => {
    await runReviewNetwork(CODE_RESULT);
    const opts = runReviewMock.mock.calls[0][1];
    expect(opts.securityPrompt).toBe(SECURITY_AUDITOR_PROMPT);
    expect(opts.domainLogicPrompt).toBe(DOMAIN_LOGIC_REVIEWER_PROMPT);
    expect(opts.performancePrompt).toBe(PERFORMANCE_REVIEWER_PROMPT);
    // No shared override unless the step set one.
    expect(opts.systemPromptOverride).toBeUndefined();
  });

  it('applies a customised parent reviewer prompt to every uncustomised persona', async () => {
    rowPrompts.reviewer = 'ACME REVIEW POLICY';
    await runReviewNetwork(CODE_RESULT);
    const opts = runReviewMock.mock.calls[0][1];
    expect(opts.securityPrompt).toBe('ACME REVIEW POLICY');
    expect(opts.domainLogicPrompt).toBe('ACME REVIEW POLICY');
    expect(opts.performancePrompt).toBe('ACME REVIEW POLICY');
  });

  it("prefers a persona's own customised prompt over a customised parent", async () => {
    rowPrompts.reviewer = 'ACME REVIEW POLICY';
    rowPrompts.securityReviewer = 'ACME SECURITY POLICY';
    await runReviewNetwork(CODE_RESULT);
    const opts = runReviewMock.mock.calls[0][1];
    expect(opts.securityPrompt).toBe('ACME SECURITY POLICY');
    expect(opts.performancePrompt).toBe('ACME REVIEW POLICY');
  });

  it('treats a parent prompt equal to the domain row (an older seed) as uncustomised', async () => {
    // A deployment seeded before the constant was reworded: both rows hold the
    // same older text, which is not the current constant.
    rowPrompts.reviewer = 'OLDER DOMAIN LOGIC SEED';
    rowPrompts.domainLogicReviewer = 'OLDER DOMAIN LOGIC SEED';
    await runReviewNetwork(CODE_RESULT);
    const opts = runReviewMock.mock.calls[0][1];
    expect(opts.securityPrompt).toBe(SECURITY_AUDITOR_PROMPT);
    expect(opts.performancePrompt).toBe(PERFORMANCE_REVIEWER_PROMPT);
    expect(opts.domainLogicPrompt).toBe('OLDER DOMAIN LOGIC SEED');
  });

  it('falls back to the built-in constant when a persona row has no prompt', async () => {
    rowPrompts.performanceReviewer = undefined;
    await runReviewNetwork(CODE_RESULT);
    expect(runReviewMock.mock.calls[0][1].performancePrompt).toBe(PERFORMANCE_REVIEWER_PROMPT);
  });

  it('still reviews when the parent reviewer row cannot be resolved', async () => {
    resolveAgentMock.mockImplementation(async (key: string) => {
      if (key === 'reviewer') {
        throw new Error('ConfigMissingError');
      }
      return { model: { systemPrompt: rowPrompts[key] }, skills: [] };
    });
    await runReviewNetwork(CODE_RESULT);
    expect(runReviewMock.mock.calls[0][1].securityPrompt).toBe(SECURITY_AUDITOR_PROMPT);
  });

  it('passes a step-level prompt through as the override', async () => {
    await runReviewNetwork(CODE_RESULT, undefined, 'STEP PROMPT');
    expect(runReviewMock.mock.calls[0][1].systemPromptOverride).toBe('STEP PROMPT');
  });
});
