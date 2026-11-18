import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  events: [] as string[],
  persist: vi.fn(async (_tracer: unknown, _key: string) => {}),
  runAgent: vi.fn(),
  runtime: 'mastra',
  scratch: vi.fn(),
  toolKeys: ['browser'] as string[] | null,
  toolsetOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('../agents/browserTools.js', () => ({
  BrowserToolset: class {
    constructor(options: Record<string, unknown>) {
      m.toolsetOptions.push(options);
    }
    async close() {
      m.events.push('toolset.close');
      await m.close();
    }
  },
  createMastraBrowserTools: vi.fn(() => ({ browser_navigate: { id: 'browser_navigate' } })),
}));
vi.mock('../lib/scratchBrowserWorkspace.js', () => ({ createScratchBrowserWorkspace: m.scratch }));
vi.mock('../agents/knowledgeTools.js', () => ({ buildKnowledgeTools: vi.fn() }));
vi.mock('../agents/mcpTools.js', () => ({ loadMcpTools: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: m.persist,
  startTraceFlushing: vi.fn(() => () => {}),
}));
vi.mock('../lib/config/agentResolver.js', () => ({
  resolveAgent: vi.fn(async (key: string) => ({
    key,
    model: { spec: 'anthropic/x' },
    toolKeys: m.toolKeys,
  })),
}));
vi.mock('../lib/config/agentRuntime.js', () => ({
  resolveAgentRuntime: vi.fn(async () => ({ runtime: m.runtime, source: 'default' })),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async () => ({ systemPrompt: 'base', tools: {} })),
}));
vi.mock('../lib/config/mcpConnection.js', () => ({ resolveAgentMcpUrl: vi.fn(async () => null) }));
vi.mock('../lib/execUtils.js', () => ({ throwIfActivityCancelled: vi.fn() }));
vi.mock('../lib/mcpApproval.js', () => ({ withMcpApproval: vi.fn(async (t: unknown) => t) }));
vi.mock('../lib/runSteering.js', () => ({ createSteeringPrepareStep: vi.fn(() => () => {}) }));
vi.mock('../lib/usdCapGuard.js', () => ({ assertModelPricedForUsdCap: vi.fn(async () => {}) }));
vi.mock('./runAgent.js', () => ({ runAgent: m.runAgent }));

import { runRepolessAgent } from './runRepolessAgentTask.js';

const input = {
  agentRef: 'contentWriter',
  baseCtx: { orgId: 'org-1', teamId: 'team-1' },
  effective: { maxSteps: 7, maxWallClockSeconds: 60 },
  key: 'contentWriter',
  prompt: 'look at the docs site',
  runId: 'run-1',
};

const WS = { containerId: 'workspace-aaaa', destroy: m.destroy, egressPolicy: 'restricted' };
const ok = () => ({
  allowedHostCount: 3,
  allowedHosts: ['a.com', 'b.com', 'c.com'],
  ok: true,
  workspace: WS,
});

/** The tracer's records, by name, as the run left them. */
function events(): Array<{ toolName: string; outputJson?: Record<string, unknown> }> {
  const tracer = m.persist.mock.calls.at(-1)?.[0] as { records: Array<{ toolName: string }> };
  return tracer.records as never;
}
const event = (name: string) => events().find((e) => e.toolName.includes(name));

beforeEach(() => {
  vi.clearAllMocks();
  m.toolKeys = ['browser'];
  m.runtime = 'mastra';
  m.events = [];
  m.toolsetOptions = [];
  m.scratch.mockResolvedValue(ok());
  m.runAgent.mockResolvedValue({ costUsd: 0.1, stepCount: 2, text: 'done' });
  m.close.mockResolvedValue(undefined);
  m.destroy.mockImplementation(async () => {
    m.events.push('destroy');
  });
});

describe('a repo-less child that grants the browser', () => {
  it('makes a scratch container for its team, binds only the browser tools, and removes it', async () => {
    const seen: unknown[] = [];
    m.runAgent.mockImplementation(async (spec: { tools: Record<string, unknown> }) => {
      seen.push(Object.keys(spec.tools));
      expect(m.destroy).not.toHaveBeenCalled();
      return { costUsd: 0, stepCount: 1, text: 'done' };
    });
    const r = await runRepolessAgent(input);
    expect(m.scratch).toHaveBeenCalledWith({ teamId: 'team-1' });
    // Browser tools only: no readFile, writeFile, bash or listDirectory.
    expect(seen).toEqual([['browser_navigate']]);
    expect(m.toolsetOptions[0]).toMatchObject({
      allowedHosts: ['a.com', 'b.com', 'c.com'],
      containerId: 'workspace-aaaa',
      repoId: null,
      workspace: WS,
    });
    const options = m.runAgent.mock.calls[0]?.[2] as { selfRecordingTools: Set<string> };
    expect(options.selfRecordingTools.has('browser_navigate')).toBe(true);
    // The toolset closes (reads evidence out) before the container goes.
    expect(m.events).toEqual(['toolset.close', 'destroy']);
    expect(r).toMatchObject({ deliver: 'none', text: 'done' });
    // The summary carries a count, not the hosts.
    expect(event('agent.browser_egress')?.outputJson).toEqual({
      agentKey: 'contentWriter',
      allowedHostCount: 3,
      egressPolicy: 'restricted',
    });
    expect(JSON.stringify(events())).not.toContain('a.com');
    expect(event('agent.browser_unavailable')).toBeUndefined();
  });

  it('still binds no workspace tool when the agent grants them with the browser', async () => {
    m.toolKeys = ['browser', 'readFile', 'writeFile', 'bash', 'listDirectory'];
    await runRepolessAgent(input);
    const spec = m.runAgent.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(Object.keys(spec.tools)).toEqual(['browser_navigate']);
  });

  it('removes the container when the model run fails', async () => {
    m.runAgent.mockRejectedValue(new Error('model down'));
    await expect(runRepolessAgent(input)).rejects.toThrow('model down');
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.destroy).toHaveBeenCalledTimes(1);
    expect(m.persist).toHaveBeenCalled();
  });

  it('removes the container when the run is aborted by its deadline', async () => {
    m.runAgent.mockImplementation(
      async (_s: unknown, _p: unknown, o: { abortSignal: AbortSignal }) =>
        Promise.reject(o.abortSignal.reason ?? new Error('aborted'))
    );
    const abort = new Error('deadline');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(abort));
    await expect(runRepolessAgent(input)).rejects.toBe(abort);
    expect(m.destroy).toHaveBeenCalledTimes(1);
  });

  it('removes the container when closing the toolset fails', async () => {
    m.close.mockRejectedValue(new Error('evidence copy failed'));
    await runRepolessAgent(input);
    expect(m.destroy).toHaveBeenCalledTimes(1);
  });

  it('applies the run ceilings to the browser run too', async () => {
    await runRepolessAgent(input);
    expect(m.runAgent.mock.calls[0]?.[2]).toMatchObject({ maxSteps: 7 });
  });

  it('runs without a browser, and says why, when the scratch container is refused', async () => {
    m.scratch.mockResolvedValue({ ok: false, reason: 'the worker egress proxy is not configured' });
    const r = await runRepolessAgent(input);
    expect(r.text).toBe('done');
    const spec = m.runAgent.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(spec.tools).toEqual({});
    expect(m.toolsetOptions).toEqual([]);
    expect(m.destroy).not.toHaveBeenCalled();
    expect(event('agent.browser_unavailable')?.outputJson).toEqual({
      agentKey: 'contentWriter',
      reason: 'the worker egress proxy is not configured',
    });
    expect(event('agent.browser_egress')).toBeUndefined();
  });

  it('runs without a browser when creating the container throws', async () => {
    m.scratch.mockRejectedValue(new Error('docker daemon unreachable'));
    const r = await runRepolessAgent(input);
    expect(r.text).toBe('done');
    expect(m.toolsetOptions).toEqual([]);
    expect(String(event('agent.browser_unavailable')?.outputJson?.reason)).toContain(
      'docker daemon unreachable'
    );
  });

  it('refuses a harness-runtime agent before any container exists', async () => {
    m.runtime = 'claude-code';
    await expect(runRepolessAgent(input)).rejects.toMatchObject({
      type: 'AGENT_RUN_NEEDS_WORKSPACE',
    });
    expect(m.scratch).not.toHaveBeenCalled();
  });
});

describe('a repo-less child that does not grant the browser', () => {
  it.each([[null], [[]], [['searchKnowledge', 'mcp']]])(
    'creates no container (toolKeys %j)',
    async (toolKeys) => {
      m.toolKeys = toolKeys as string[] | null;
      await runRepolessAgent(input);
      expect(m.scratch).not.toHaveBeenCalled();
      expect(m.toolsetOptions).toEqual([]);
      expect(m.destroy).not.toHaveBeenCalled();
      expect(event('agent.browser_unavailable')).toBeUndefined();
      expect(event('agent.browser_egress')).toBeUndefined();
    }
  );
});
