import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findChannel } = vi.hoisted(() => ({ findChannel: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { slackChannel: { findUnique: findChannel } } }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
}));

vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue({ agentKey: 'reviewer' }),
}));

vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn().mockResolvedValue({ runtime: null }),
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
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import { runAgent } from './runAgent.js';
import { runAgentNode } from './runAgentNode.js';

const mockedResolveSpec = vi.mocked(resolveAgentSpec);
const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveMcpUrl = vi.mocked(resolveAgentMcpUrl);
const mockedLoadMcpTools = vi.mocked(loadMcpTools);

beforeEach(() => vi.clearAllMocks());

describe('runAgentNode', () => {
  it('runs an agent that asks for the harness on Mastra, and says so on the trace', async () => {
    vi.mocked(resolveAgent).mockResolvedValueOnce({ runtime: 'claude-code' } as never);
    const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

    await runAgentNode({ agentRef: 'reviewer', userMessage: 'check the diff' });

    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({
      name: 'agent.runtime_not_applicable',
      outputJson: {
        agentKey: 'reviewer',
        ranOn: 'mastra',
        reason: 'no workspace',
        runtime: 'claude-code',
      },
    });
    events.mockRestore();
  });

  it('records no runtime event for an agent with no opinion', async () => {
    const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
    await runAgentNode({ agentRef: 'reviewer', userMessage: 'check the diff' });
    expect(events).not.toHaveBeenCalled();
    events.mockRestore();
  });

  it('resolves a floating agentRef and runs it with the literal user message', async () => {
    const result = await runAgentNode({ agentRef: 'reviewer', userMessage: 'check the diff' });

    expect(mockedResolveSpec).toHaveBeenCalledWith(
      { agentKey: 'reviewer', basePrompt: '', promptOverride: undefined },
      { teamId: 'team-1' }
    );
    expect(mockedRunAgent).toHaveBeenCalledWith({ agentKey: 'reviewer' }, 'check the diff', {
      ctx: { teamId: 'team-1' },
      selfRecordingTools: new Set(),
      spanName: 'llm.agent_node',
      tracer: expect.any(AgentTracer),
    });
    expect(result).toEqual({ object: undefined, text: 'verdict' });
  });

  it("resolves a repo-less channel task at the channel's team and org, not the channel alone", async () => {
    // A general channel task has no ActiveWorkflow row, so the ambient context
    // carries neither team nor org.
    vi.mocked(currentRequestContext).mockResolvedValueOnce({});
    findChannel.mockResolvedValueOnce({ orgId: 'org-9', teamId: 'team-9' });

    await runAgentNode({ agentRef: 'channelAssistant', channelId: 'chan-1', userMessage: 'go' });

    const scope = { channelId: 'chan-1', orgId: 'org-9', teamId: 'team-9' };
    expect(mockedResolveSpec).toHaveBeenCalledWith(expect.anything(), scope);
    expect(mockedRunAgent).toHaveBeenCalledWith(expect.anything(), 'go', {
      ctx: scope,
      selfRecordingTools: new Set(),
      spanName: 'llm.agent_node',
      tracer: expect.any(AgentTracer),
    });
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
      ctx: { teamId: 'team-1' },
      selfRecordingTools: new Set(),
      spanName: 'llm.agent_node',
      tracer: expect.any(AgentTracer),
    });
  });

  it('falls back to JSON of inputs for multi-key (or non-string) inputs', async () => {
    await runAgentNode({ agentRef: 'reviewer', inputs: { bar: 2, foo: 'a' } });
    expect(mockedRunAgent).toHaveBeenCalledWith(
      { agentKey: 'reviewer' },
      JSON.stringify({ bar: 2, foo: 'a' }),
      {
        ctx: { teamId: 'team-1' },
        selfRecordingTools: new Set(),
        spanName: 'llm.agent_node',
        tracer: expect.any(AgentTracer),
      }
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
    mockedResolveMcpUrl.mockResolvedValueOnce({ url: 'https://mcp.example.com/mcp' });
    mockedLoadMcpTools.mockResolvedValueOnce({ close, tools: { mcp_x: 'mt' } } as never);

    await runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' });

    expect(mockedLoadMcpTools).toHaveBeenCalledWith(
      'https://mcp.example.com/mcp',
      expect.any(AgentTracer),
      { callTimeoutMs: undefined, listTimeoutMs: undefined }
    );
    // Spec/built-in tools win over MCP tools on key collision. Only the MCP
    // tool records itself, so only it is skipped when the loop's steps are read.
    expect(mockedRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { existing: 't', mcp_x: 'mt' } }),
      'hi',
      {
        ctx: { teamId: 'team-1' },
        selfRecordingTools: new Set(['mcp_x']),
        spanName: 'llm.agent_node',
        tracer: expect.any(AgentTracer),
      }
    );
    expect(close).toHaveBeenCalledTimes(1);
    // One tracer for the MCP rows and the loop's rows, persisted once, so their
    // seq values form one sequence instead of two that both start at 0.
    const mcpTracer = mockedLoadMcpTools.mock.calls[0]?.[1];
    expect(mockedRunAgent.mock.calls[0]?.[2]?.tracer).toBe(mcpTracer);
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledWith(mcpTracer, 'reviewer');
  });

  it('threads the connection timeout overrides into loadMcpTools', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockedResolveSpec.mockResolvedValueOnce({
      agentKey: 'reviewer',
      tools: { existing: 't' },
    } as never);
    mockedResolveMcpUrl.mockResolvedValueOnce({
      callTimeoutMs: 90_000,
      listTimeoutMs: 30_000,
      url: 'https://mcp.example.com/mcp',
    });
    mockedLoadMcpTools.mockResolvedValueOnce({ close, tools: { mcp_x: 'mt' } } as never);

    await runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' });

    expect(mockedLoadMcpTools).toHaveBeenCalledWith(
      'https://mcp.example.com/mcp',
      expect.any(AgentTracer),
      { callTimeoutMs: 90_000, listTimeoutMs: 30_000 }
    );
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
      {
        ctx: { teamId: 'team-1' },
        selfRecordingTools: new Set(),
        spanName: 'llm.agent_node',
        tracer: expect.any(AgentTracer),
      }
    );
  });

  it('leaves the user message untouched when steering is empty', async () => {
    await runAgentNode({ agentRef: 'reviewer', steering: [], userMessage: 'hi' });
    expect(mockedRunAgent).toHaveBeenCalledWith({ agentKey: 'reviewer' }, 'hi', {
      ctx: { teamId: 'team-1' },
      selfRecordingTools: new Set(),
      spanName: 'llm.agent_node',
      tracer: expect.any(AgentTracer),
    });
  });

  it('persists the MCP rows and closes the client when the run throws after binding', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockedResolveMcpUrl.mockResolvedValueOnce({ url: 'https://mcp.example.com/mcp' });
    mockedLoadMcpTools.mockResolvedValueOnce({ close, tools: {} } as never);
    mockedRunAgent.mockRejectedValueOnce(new Error('model down'));

    await expect(runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' })).rejects.toThrow(
      'model down'
    );

    expect(close).toHaveBeenCalledTimes(1);
    const mcpTracer = mockedLoadMcpTools.mock.calls[0]?.[1];
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledWith(mcpTracer, 'reviewer');
  });

  it('still persists the trace when resolving the MCP connection throws', async () => {
    mockedResolveMcpUrl.mockRejectedValueOnce(new Error('connection row unreadable'));

    await expect(runAgentNode({ agentRef: 'reviewer', userMessage: 'hi' })).rejects.toThrow(
      'connection row unreadable'
    );

    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
  });
});
