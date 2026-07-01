import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

const { fakeSpec } = vi.hoisted(() => ({ fakeSpec: { agentKey: 'workflowExplainer' } }));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue(fakeSpec),
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { explainWorkflowSpec } from './explainWorkflowSpec.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveSpec = vi.mocked(resolveAgentSpec);

const SPEC: WorkflowSpec = {
  description: 'demo',
  entry: 'done',
  name: 'Demo',
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

beforeEach(() => vi.clearAllMocks());

describe('explainWorkflowSpec', () => {
  it('resolves the explainer agent and returns the structured explanation', async () => {
    mockedRunAgent.mockResolvedValue({ object: { explanation: 'It does X.' } });

    const result = await explainWorkflowSpec({ spec: SPEC, teamId: 'team-1' });

    expect(result).toEqual({ explanation: 'It does X.' });
    expect(mockedResolveSpec).toHaveBeenCalledWith(
      expect.objectContaining({ agentKey: 'workflowExplainer', outputSchema: expect.anything() }),
      { teamId: 'team-1' }
    );
    expect(mockedRunAgent).toHaveBeenCalledWith(
      fakeSpec,
      expect.stringContaining('"entry": "done"'),
      {
        spanName: 'llm.workflow_explainer',
      }
    );
  });

  it('falls back to free text when the provider skips the schema', async () => {
    mockedRunAgent.mockResolvedValue({ text: 'plain prose explanation' });
    const result = await explainWorkflowSpec({ spec: SPEC });
    expect(result.explanation).toBe('plain prose explanation');
  });

  it('throws when there is no explanation at all', async () => {
    mockedRunAgent.mockResolvedValue({});
    await expect(explainWorkflowSpec({ spec: SPEC })).rejects.toThrow(/no explanation/);
  });
});
