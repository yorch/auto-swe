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
  getModel: vi.fn(async () => ({})),
  getModelSpec: vi.fn(async () => 'anthropic/claude-x'),
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

import { MAX_SUBTASKS, planDecomposition } from './decomposer.js';

const REQUEST = {
  budgetTier: 'STANDARD',
  description: 'build the whole feature',
  externalTicketId: 'T-1',
  repoId: 'repo-1',
} as never;

const subtask = (id: string) => ({
  description: `implement part ${id} of the feature`,
  id,
  title: `Part ${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('planDecomposition structured output', () => {
  it('returns the validated subtasks', async () => {
    generateMock.mockResolvedValue({ object: { subtasks: [subtask('a'), subtask('b')] } });
    const result = await planDecomposition(REQUEST);
    expect(result.subtasks.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('falls back to a single subtask when the object fails the schema', async () => {
    const tooMany = Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => subtask(`s${i}`));
    generateMock.mockResolvedValue({ object: { subtasks: tooMany } });
    const result = await planDecomposition(REQUEST);
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0].id).toBe('main');
    expect(result.rationale).toContain('failed validation');
  });

  it('falls back to a single subtask when there is no structured output', async () => {
    generateMock.mockResolvedValue({ object: undefined });
    const result = await planDecomposition(REQUEST);
    expect(result.subtasks.map((s) => s.id)).toEqual(['main']);
    expect(result.rationale).toContain('no structured output');
  });
});
