import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findChannel, findRepo, harness } = vi.hoisted(() => ({
  findChannel: vi.fn(),
  findRepo: vi.fn(),
  harness: {
    bind: vi.fn(),
    build: vi.fn(),
    close: vi.fn(),
    select: vi.fn(),
  },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUniqueOrThrow: findRepo },
    slackChannel: { findUnique: findChannel },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => (key === 'workspace.agentMaxSteps' ? 40 : 20_000)),
}));
vi.mock('../lib/config/agentRuntime.js', () => ({
  resolveAgentRuntime: vi.fn().mockResolvedValue({ runtime: 'mastra', source: 'default' }),
}));
vi.mock('../agents/harnessRegistry.js', () => ({ HARNESSES: { select: harness.select } }));
vi.mock('../agents/implementerRuntime.js', () => ({
  runImplementerTurn: vi.fn().mockResolvedValue({ text: 'harness verdict' }),
}));
vi.mock('../agents/workspaceTools.js', () => ({
  buildWorkspaceTools: vi.fn(() => ({
    bash: 'B',
    listDirectory: 'L',
    readFile: 'R',
    writeFile: 'W',
  })),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: vi.fn(() => ({
    cloneCredentials: async () => ({ authedCloneUrl: 'https://x-access-token:T@h/o/r.git' }),
  })),
  toRepoRef: vi.fn(() => ({ organizationName: 'o', repoName: 'r' })),
}));
vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(),
  fetchBranchesSubcommand: (refs: string[]) => `fetch origin ${refs.join(' ')}`,
  shellQuote: (s: string) => `'${s}'`,
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('../lib/costTracking.js', () => ({ assertBudgetAvailable: vi.fn(async () => {}) }));
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: vi.fn(async () => {}) }));

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

import { ApplicationFailure } from '@temporalio/activity';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import { loadMcpTools } from '../agents/mcpTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { resolveAgentRuntime } from '../lib/config/agentRuntime.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import { runAgent } from './runAgent.js';
import { runAgentNode } from './runAgentNode.js';
import { createWorkspace } from './workspace.js';

const mockedResolveSpec = vi.mocked(resolveAgentSpec);
const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveMcpUrl = vi.mocked(resolveAgentMcpUrl);
const mockedLoadMcpTools = vi.mocked(loadMcpTools);

beforeEach(() => vi.clearAllMocks());

describe('runAgentNode', () => {
  it('runs an agent pinned to the harness on Mastra without a workspace, and says so', async () => {
    vi.mocked(resolveAgentRuntime).mockResolvedValueOnce({ runtime: 'claude-code', source: 'run' });
    const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

    await runAgentNode({ agentRef: 'reviewer', userMessage: 'check the diff' });

    // The run's pin decides, under the node's scope, with Mastra as the default.
    expect(vi.mocked(resolveAgentRuntime)).toHaveBeenCalledWith(
      'reviewer',
      { teamId: 'team-1' },
      'mastra'
    );
    expect(mockedRunAgent).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({
      name: 'agent.runtime_not_applicable',
      outputJson: {
        agentKey: 'reviewer',
        ranOn: 'mastra',
        reason: 'no workspace',
        runtime: 'claude-code',
        source: 'run',
      },
    });
    expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
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
  describe('in a checkout', () => {
    const workspace = {
      destroy: vi.fn(async () => {}),
      exec: vi.fn(async () => ''),
      gitAuthed: vi.fn(async () => ''),
    };

    beforeEach(() => {
      findRepo.mockResolvedValue({
        defaultBranch: 'main',
        executorImage: null,
        id: 'repo-1',
        installation: null,
      });
      vi.mocked(createWorkspace).mockResolvedValue(workspace as never);
      vi.mocked(resolveAgent).mockResolvedValue({
        model: { apiKey: 'k', spec: 'anthropic/claude-sonnet-5-5' },
        runtime: null,
        toolKeys: null,
      } as never);
      mockedResolveSpec.mockResolvedValue({
        agentKey: 'reviewer',
        systemPrompt: 'Review.',
      } as never);
      harness.build.mockReturnValue({ close: harness.close, runTurn: vi.fn() });
      harness.bind.mockReturnValue({ build: harness.build, kind: 'claude-code' });
      harness.select.mockReturnValue({ bind: harness.bind });
    });

    it("checks out the run's code branch and gives the Mastra loop the agent-run read tools", async () => {
      const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

      const result = await runAgentNode({
        agentRef: 'reviewer',
        userMessage: 'where is auth handled?',
        workspace: { branch: 'auto/JIRA-1-sub', repoId: 'repo-1', ticketId: 'JIRA-1' },
      });

      // Cut from the default branch with the repository's own image, then moved
      // to the pushed branch the code result names.
      expect(vi.mocked(createWorkspace)).toHaveBeenCalledWith(
        'https://x-access-token:T@h/o/r.git',
        'auto/JIRA-1-sub',
        'main',
        undefined
      );
      expect(workspace.gitAuthed).toHaveBeenCalledWith('fetch origin auto/JIRA-1-sub');
      expect(workspace.exec).toHaveBeenCalledWith("git reset --hard origin/'auto/JIRA-1-sub'");
      // `toolKeys: null` grants the read tools only, as an agent run does.
      expect(mockedResolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ availableTools: { listDirectory: 'L', readFile: 'R' } }),
        { teamId: 'team-1' }
      );
      const [spec, message, options] = mockedRunAgent.mock.calls[0] ?? [];
      expect(spec?.systemPrompt).toMatch(/^Review\.\n\nYou are working in a throwaway checkout/);
      expect(message).toBe('where is auth handled?');
      expect(options?.selfRecordingTools).toEqual(new Set());
      expect(events).toHaveBeenCalledWith({
        name: 'agent.runtime',
        outputJson: {
          agentKey: 'reviewer',
          checkout: 'auto/JIRA-1-sub',
          runtime: 'mastra',
          source: 'default',
        },
      });
      expect(harness.select).not.toHaveBeenCalled();
      expect(workspace.destroy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ object: undefined, text: 'verdict' });
      events.mockRestore();
    });

    it("defaults to the run's own branch, and reads the default branch until it is pushed", async () => {
      workspace.gitAuthed.mockRejectedValueOnce(new Error("couldn't find remote ref"));
      const events = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

      await runAgentNode({
        agentRef: 'reviewer',
        workspace: { repoId: 'repo-1', ticketId: 'JIRA-1' },
      });

      expect(vi.mocked(createWorkspace).mock.calls[0]?.[1]).toBe('auto/JIRA-1');
      expect(workspace.gitAuthed).toHaveBeenCalledWith('fetch origin auto/JIRA-1');
      expect(workspace.exec).not.toHaveBeenCalled();
      expect(events).toHaveBeenCalledWith({
        name: 'agent.runtime',
        outputJson: expect.objectContaining({ checkout: 'main' }),
      });
      events.mockRestore();
    });

    it('runs one harness turn in the checkout when the run pinned the agent to it', async () => {
      vi.mocked(resolveAgentRuntime).mockResolvedValueOnce({
        runtime: 'claude-code',
        source: 'run',
      });
      vi.mocked(resolveAgent).mockResolvedValue({
        model: { apiKey: 'k', spec: 'anthropic/claude-sonnet-5-5' },
        runtime: 'claude-code',
        toolKeys: ['readFile', 'bash', 'mcp'],
      } as never);

      const result = await runAgentNode({
        agentRef: 'reviewer',
        spanName: 'llm.audit',
        userMessage: 'audit the auth module',
        workspace: { branch: 'auto/JIRA-1', repoId: 'repo-1', ticketId: 'JIRA-1' },
      });

      expect(harness.select).toHaveBeenCalledWith('claude-code');
      expect(harness.bind).toHaveBeenCalledWith('reviewer', {
        apiKey: 'k',
        spec: 'anthropic/claude-sonnet-5-5',
      });
      // Bound before the clone: a model the harness cannot drive costs no container.
      expect(harness.bind.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(createWorkspace).mock.invocationCallOrder[0] ?? 0
      );
      // Exactly the workspace tools the list names; `mcp` is a separate decision.
      expect(harness.build).toHaveBeenCalledWith({
        exactToolKeys: ['readFile', 'bash'],
        loadProjectSettings: true,
        maxTurns: 40,
        mcp: null,
        tracer: expect.any(AgentTracer),
        workspace,
      });
      expect(vi.mocked(runImplementerTurn)).toHaveBeenCalledWith({
        context: { agentNode: 'reviewer' },
        role: 'reviewer',
        runtime: expect.objectContaining({ close: harness.close }),
        system: expect.stringMatching(/^Review\.\n\nYou are working in a throwaway checkout/),
        tracer: expect.any(AgentTracer),
        usageEvent: 'llm.audit',
        user: 'audit the auth module',
      });
      expect(mockedRunAgent).not.toHaveBeenCalled();
      // The harness session is closed before its container goes.
      expect(harness.close).toHaveBeenCalledTimes(1);
      expect(harness.close.mock.invocationCallOrder[0]).toBeLessThan(
        workspace.destroy.mock.invocationCallOrder[0] ?? 0
      );
      expect(result).toEqual({ text: 'harness verdict' });
    });

    it('refuses a model the harness cannot drive before cloning', async () => {
      vi.mocked(resolveAgentRuntime).mockResolvedValueOnce({
        runtime: 'claude-code',
        source: 'agent',
      });
      harness.bind.mockImplementationOnce(() => {
        throw ApplicationFailure.nonRetryable('not anthropic', 'HARNESS_UNSUPPORTED_MODEL');
      });

      await expect(
        runAgentNode({ agentRef: 'reviewer', workspace: { repoId: 'repo-1', ticketId: 'JIRA-1' } })
      ).rejects.toThrow('not anthropic');
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
      expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    });

    it('fails without retrying when the run has no repository', async () => {
      const failure = await runAgentNode({
        agentRef: 'reviewer',
        workspace: { repoId: null, ticketId: 'JIRA-1' },
      }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ nonRetryable: true, type: 'AGENT_NODE_NO_REPOSITORY' });
      expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
    });

    it('destroys the checkout when the turn throws', async () => {
      mockedRunAgent.mockRejectedValueOnce(new Error('model down'));
      await expect(
        runAgentNode({ agentRef: 'reviewer', workspace: { repoId: 'repo-1', ticketId: 'JIRA-1' } })
      ).rejects.toThrow('model down');
      expect(workspace.destroy).toHaveBeenCalledTimes(1);
      expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    });
  });
});
