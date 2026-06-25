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

vi.mock('../lib/config/mcpConnection.js', () => ({
  resolveAgentMcpUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agents/mcpTools.js', () => ({ loadMcpTools: vi.fn() }));

vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));

import { loadMcpTools } from '../agents/mcpTools.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import { runAgent } from './runAgent.js';
import { runAgentNode } from './runAgentNode.js';

const mockedResolveSpec = vi.mocked(resolveAgentSpec);
const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveMcpUrl = vi.mocked(resolveAgentMcpUrl);
const mockedLoadMcpTools = vi.mocked(loadMcpTools);

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

  it('sends a single string input as the plain message (not JSON) when no userMessage', async () => {
    // The Channel Task spec's agent node has one `task` input bound to the task
    // description — it must reach the agent as prose, not `{"task":"…"}`.
    await runAgentNode({ agentRef: 'reviewer', inputs: { task: 'add a health endpoint' } });
    expect(mockedRunAgent).toHaveBeenCalledWith({ agentKey: 'reviewer' }, 'add a health endpoint', {
      spanName: 'llm.agent_node',
    });
  });

  it('falls back to JSON of inputs for multi-key (or non-string) inputs', async () => {
    await runAgentNode({ agentRef: 'reviewer', inputs: { bar: 2, foo: 'a' } });
    expect(mockedRunAgent).toHaveBeenCalledWith(
      { agentKey: 'reviewer' },
      JSON.stringify({ bar: 2, foo: 'a' }),
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

  it('binds MCP tools when the agent enables them and closes the client after', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockedResolveSpec.mockResolvedValueOnce({
      agentKey: 'reviewer',
      tools: { existing: 't' },
    } as never);
    mockedResolveMcpUrl.mockResolvedValueOnce('https://mcp.example.com/mcp');
    mockedLoadMcpTools.mockResolvedValueOnce({ close, tools: { mcp_x: 'mt' } } as never);

    await runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' });

    expect(mockedLoadMcpTools).toHaveBeenCalledWith(
      'https://mcp.example.com/mcp',
      expect.any(AgentTracer)
    );
    // Spec/built-in tools win over MCP tools on key collision.
    expect(mockedRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { existing: 't', mcp_x: 'mt' } }),
      'hi',
      { spanName: 'llm.agent_node' }
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('skips MCP loading when the agent has no mcp server', async () => {
    await runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' });
    expect(mockedLoadMcpTools).not.toHaveBeenCalled();
  });

  it('prepends a labeled steering block to the user message when steering is present', async () => {
    await runAgentNode({
      agentRef: 'reviewer',
      steering: ['use the v2 endpoint', 'keep it backwards compatible'],
      userMessage: 'implement the change',
    });
    expect(mockedRunAgent).toHaveBeenCalledWith(
      { agentKey: 'reviewer' },
      'implement the change\n\n[Steering update from the channel — incorporate this]:\n- use the v2 endpoint\n- keep it backwards compatible',
      { spanName: 'llm.agent_node' }
    );
  });

  it('leaves the user message untouched when steering is empty', async () => {
    await runAgentNode({ agentRef: 'reviewer', steering: [], userMessage: 'hi' });
    expect(mockedRunAgent).toHaveBeenCalledWith({ agentKey: 'reviewer' }, 'hi', {
      spanName: 'llm.agent_node',
    });
  });
});
