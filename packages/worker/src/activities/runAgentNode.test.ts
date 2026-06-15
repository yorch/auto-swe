import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
}));

vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue({ agentKey: 'reviewer' }),
}));

vi.mock('./runAgent.js', () => ({
  runAgent: vi.fn().mockResolvedValue({ object: undefined, text: 'verdict' }),
}));

import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { runAgent } from './runAgent.js';
import { runAgentNode } from './runAgentNode.js';

const mockedResolveSpec = vi.mocked(resolveAgentSpec);
const mockedRunAgent = vi.mocked(runAgent);

beforeEach(() => vi.clearAllMocks());

describe('runAgentNode', () => {
  it('resolves a floating agentRef and runs it with the literal user message', async () => {
    const result = await runAgentNode({ agentRef: 'reviewer', userMessage: 'check the diff' });

    expect(mockedResolveSpec).toHaveBeenCalledWith(
      { agentKey: 'reviewer', basePrompt: '', promptOverride: undefined },
      { teamId: 'team-1' }
    );
    expect(mockedRunAgent).toHaveBeenCalledWith({ agentKey: 'reviewer' }, 'check the diff', {
      spanName: 'llm.agent_node',
    });
    expect(result).toEqual({ object: undefined, text: 'verdict' });
  });

  it('pins the version from an "@version" agentRef on top of the run snapshot', async () => {
    await runAgentNode({ agentRef: 'reviewer@5' });

    // The pinned version is merged into ctx.agentVersions for resolveAgent.
    expect(mockedResolveSpec).toHaveBeenCalledWith(
      { agentKey: 'reviewer', basePrompt: '', promptOverride: undefined },
      { agentVersions: { reviewer: 5 }, teamId: 'team-1' }
    );
  });

  it('falls back to JSON of inputs when no userMessage is given', async () => {
    await runAgentNode({ agentRef: 'reviewer', inputs: { foo: 'bar' } });
    expect(mockedRunAgent).toHaveBeenCalledWith(
      { agentKey: 'reviewer' },
      JSON.stringify({ foo: 'bar' }),
      { spanName: 'llm.agent_node' }
    );
  });

  it('forwards a per-node systemPrompt override', async () => {
    await runAgentNode({ agentRef: 'reviewer', systemPrompt: 'be terse' });
    expect(mockedResolveSpec).toHaveBeenCalledWith(
      expect.objectContaining({ promptOverride: 'be terse' }),
      expect.anything()
    );
  });
});
