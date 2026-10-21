import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The planner, decomposer and security gate each ask the USD-cap guard before
 * their model call. These tests pin that a refusal stops the call before it is
 * made, and that a passing guard (an uncapped organization) lets it proceed.
 */

const { assertRolePricedMock, generateMock } = vi.hoisted(() => ({
  assertRolePricedMock: vi.fn(async (_role: string, _spec?: string) => {}),
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
  getBoundModel: vi.fn(async () => ({
    agent: { id: 'agent-row-1', version: 3 },
    model: {},
    spec: 'openrouter/unpriced',
    systemPrompt: null,
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

import { AgentTracer } from '../lib/agentTracer.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getBoundModel } from '../lib/models.js';
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
    expect(assertRolePricedMock).toHaveBeenCalledWith(role, 'openrouter/unpriced');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('proceeds to the model call when the guard passes (uncapped organization)', async () => {
    await call().catch(() => undefined);
    expect(assertRolePricedMock).toHaveBeenCalledWith(role, 'openrouter/unpriced');
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['decomposer', () => planDecomposition(REQUEST), 'decomposer', 'llm.decomposer'],
  ['planner', () => decomposeEpic('epic', []), 'planner', 'llm.epic_planner'],
  [
    'security gate',
    () => scanDiffForSecurityIssues('diff --git a b'),
    'securityReview',
    'llm.security_scan',
  ],
])('%s binds its model once', (_name, call, role, span) => {
  it('prices, calls and bills the model from a single resolution', async () => {
    // A config edit lands between resolutions: the first answer is model A, any later one B.
    vi.mocked(getBoundModel)
      .mockResolvedValueOnce({ model: {}, spec: 'anthropic/model-a', systemPrompt: null } as never)
      .mockResolvedValue({ model: {}, spec: 'anthropic/model-b', systemPrompt: null } as never);
    generateMock.mockResolvedValue({
      object: undefined,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await call().catch(() => undefined);
    expect(getBoundModel).toHaveBeenCalledTimes(1);
    expect(assertRolePricedMock).toHaveBeenCalledWith(role, 'anthropic/model-a');
    expect(recordLlmUsage).toHaveBeenCalledWith(
      'wf-1',
      role,
      { inputTokens: 1, outputTokens: 1 },
      span,
      'anthropic/model-a'
    );
  });
});

// One shared check for the three single-resolution agents: the trace row carries the Agent row
// of the very resolution that bound the model, on the success path and on the failure path.
describe.each([
  ['decomposer', (t: AgentTracer) => planDecomposition(REQUEST, t)],
  ['planner', (t: AgentTracer) => decomposeEpic('epic', [], t)],
  ['security gate', () => scanDiffForSecurityIssues('diff --git a b')],
])('%s stamps its Agent row on the trace', (_name, call) => {
  beforeEach(() => {
    // The single-resolution tests above leave their last mockResolvedValue behind.
    vi.mocked(getBoundModel).mockResolvedValue({
      agent: { id: 'agent-row-1', version: 3 },
      model: {},
      spec: 'openrouter/unpriced',
      systemPrompt: null,
    } as never);
  });

  it('on a failed call', async () => {
    const addLlmResponse = vi.spyOn(AgentTracer.prototype, 'addLlmResponse');
    generateMock.mockRejectedValue(new Error('provider down'));
    await call(new AgentTracer()).catch(() => undefined);
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { id: 'agent-row-1', version: 3 }, error: 'provider down' })
    );
  });

  it('on a successful call', async () => {
    const addLlmResponse = vi.spyOn(AgentTracer.prototype, 'addLlmResponse');
    generateMock.mockResolvedValue({
      object: {
        findings: [],
        passed: true,
        repos: [{ dependsOn: [], rationale: 'x', repoId: 'r' }],
        subtasks: [],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await call(new AgentTracer()).catch(() => undefined);
    const rows = addLlmResponse.mock.calls.map(([o]) => o);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.agent).toEqual({ id: 'agent-row-1', version: 3 });
    }
  });
});

// A failing assertion must not leak a spy on AgentTracer into the next test.
afterEach(() => {
  vi.restoreAllMocks();
});
