import type { PlannedRepo, RepoInfo } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.generate = generateMock;
  }),
}));
vi.mock('../lib/usdCapGuard.js', () => ({ assertRolePricedForUsdCap: vi.fn(async () => {}) }));
vi.mock('../lib/activityContext.js', () => ({ currentWorkflowId: vi.fn(() => 'wf-1') }));
vi.mock('../lib/models.js', () => ({
  getBoundModel: vi.fn(async () => ({
    model: {},
    spec: 'anthropic/claude-x',
    systemPrompt: null as string | null,
  })),
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi.fn(async () => ({
    costUsd: 0,
    inputTokens: 0,
    modelSpec: '',
    outputTokens: 0,
  })),
}));

import { decomposeEpic, normalizePlan } from './plannerAgent.js';

function repo(repoId: string): RepoInfo {
  return { description: `${repoId} desc`, language: 'ts', name: repoId, repoId };
}

function planned(repoId: string, dependsOn: string[] = []): PlannedRepo {
  return { dependsOn, description: `do ${repoId}`, repoId };
}

describe('normalizePlan', () => {
  const AVAILABLE = [repo('a'), repo('b'), repo('c')];

  it('appends every available repo the planner omitted, with no dependencies', () => {
    const plan = normalizePlan([planned('b', ['a'])], AVAILABLE);
    expect(plan.map((r) => r.repoId)).toEqual(['b', 'a', 'c']);
    expect(plan.find((r) => r.repoId === 'a')?.dependsOn).toEqual([]);
    // b's dep on a survives because a is now in the plan.
    expect(plan.find((r) => r.repoId === 'b')?.dependsOn).toEqual(['a']);
  });

  it('turns an empty planner answer into the full requested set', () => {
    expect(normalizePlan([], AVAILABLE).map((r) => r.repoId)).toEqual(['a', 'b', 'c']);
  });

  it('drops unknown repos, deps outside the plan, and self-edges', () => {
    const plan = normalizePlan(
      [planned('ghost'), planned('a', ['a', 'ghost', 'outside']), planned('b', ['a'])],
      [repo('a'), repo('b')]
    );
    expect(plan).toEqual([planned('a'), planned('b', ['a'])]);
  });

  it('dedupes a repo listed twice, keeping the first entry and the union of deps', () => {
    const plan = normalizePlan(
      [planned('c', ['a']), planned('c', ['b', 'a']), planned('a'), planned('b')],
      AVAILABLE
    );
    expect(plan.map((r) => r.repoId)).toEqual(['c', 'a', 'b']);
    expect(plan[0].dependsOn).toEqual(['a', 'b']);
  });

  it('is empty only when nothing is available', () => {
    expect(normalizePlan([planned('x')], [])).toEqual([]);
  });
});

describe('decomposeEpic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes a partial plan with the omitted repos', async () => {
    generateMock.mockResolvedValue({
      object: { repos: [planned('b')] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const plan = await decomposeEpic('epic', [repo('a'), repo('b')]);
    expect(plan.map((r) => r.repoId).sort()).toEqual(['a', 'b']);
  });

  it('treats an object that fails the schema like missing structured output', async () => {
    generateMock.mockResolvedValue({
      object: { repos: [{ repoId: 'a' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(decomposeEpic('epic', [repo('a')])).rejects.toThrow(
      /did not return valid structured output/
    );
  });

  it('fails non-retryably when the final plan is empty', async () => {
    generateMock.mockResolvedValue({ object: { repos: [] }, usage: undefined });
    await expect(decomposeEpic('epic', [])).rejects.toMatchObject({
      nonRetryable: true,
      type: 'EPIC_PLAN_EMPTY',
    });
  });
});
