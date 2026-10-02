import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The planner, decomposer and security gate each ask the USD-cap guard before
 * their model call. These tests pin that a refusal stops the call before it is
 * made, and that a passing guard (an uncapped organization) lets it proceed.
 */

const { assertRolePricedMock, generateMock } = vi.hoisted(() => ({
  assertRolePricedMock: vi.fn(async (_role: string) => {}),
  generateMock: vi.fn(),
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.generate = generateMock;
  }),
}));
vi.mock('../lib/usdCapGuard.js', () => ({ assertRolePricedForUsdCap: assertRolePricedMock }));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn(() => 'wf-1'),
  persistActivityTrace: vi.fn(async () => {}),
}));
vi.mock('../lib/config/agentSkills.js', () => ({ loadAgentSkills: vi.fn(async () => []) }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('../lib/models.js', () => ({
  getModel: vi.fn(async () => ({})),
  getModelSpec: vi.fn(async () => 'openrouter/unpriced'),
  resolveSystemPrompt: vi.fn(async (_role: string, base: string) => base),
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

import { planDecomposition } from './decomposer.js';
import { decomposeEpic } from './plannerAgent.js';
import { scanDiffForSecurityIssues } from './securityReviewProcessor.js';

const unpriced = () =>
  Object.assign(new Error('Model has no price in the model catalog'), { type: 'MODEL_UNPRICED' });

const REQUEST = {
  budgetTier: 'STANDARD',
  description: 'do it',
  externalTicketId: 'T-1',
  repoId: 'repo-1',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  generateMock.mockResolvedValue({ object: undefined, usage: undefined });
});

describe.each([
  ['decomposer', () => planDecomposition(REQUEST), 'decomposer'],
  ['planner', () => decomposeEpic('epic', []), 'planner'],
  ['security gate', () => scanDiffForSecurityIssues('diff --git a b'), 'securityReview'],
])('%s USD-cap guard', (_name, call, role) => {
  it('refuses an unpriced model before the call is made', async () => {
    assertRolePricedMock.mockRejectedValueOnce(unpriced());
    await expect(call()).rejects.toMatchObject({ type: 'MODEL_UNPRICED' });
    expect(assertRolePricedMock).toHaveBeenCalledWith(role);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('proceeds to the model call when the guard passes (uncapped organization)', async () => {
    await call().catch(() => undefined);
    expect(assertRolePricedMock).toHaveBeenCalledWith(role);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
