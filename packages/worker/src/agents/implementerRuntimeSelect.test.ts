import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  buildImplementerForActivity: vi.fn(),
  claudeCodeRuntime: vi.fn((..._args: unknown[]) => ({ runTurn: vi.fn() })),
  closeMcp: vi.fn(async () => {}),
  generate: vi.fn(async (..._args: unknown[]) => ({ text: 'mastra says hi', usage: undefined })),
  resolveAgent: vi.fn(),
  resolveAgentRuntime: vi.fn(),
  resolveImplementerConfig: vi.fn(),
  resolveSetting: vi.fn(),
}));

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: h.resolveSetting }));
vi.mock('../lib/config/agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));
vi.mock('../lib/config/agentRuntime.js', () => ({ resolveAgentRuntime: h.resolveAgentRuntime }));
vi.mock('./claudeCode/runtime.js', () => ({ claudeCodeRuntime: h.claudeCodeRuntime }));
vi.mock('./implementer.js', () => ({
  buildImplementerForActivity: h.buildImplementerForActivity,
  resolveImplementerConfig: h.resolveImplementerConfig,
}));

import type { AgentTracer } from '../lib/agentTracer.js';
import { buildImplementerTurnRunner } from './implementerRuntimeSelect.js';

const skills = [
  { description: 'd1', name: 'tdd', promptText: 'Write the test first.' },
  { description: 'd2', name: 'small', promptText: 'Keep diffs small.' },
] as never;

const MENU = '## Available Skills\n- tdd: call loadSkill';

function input(
  overrides: Record<string, unknown> = {}
): Parameters<typeof buildImplementerTurnRunner>[0] {
  return {
    ctx: { orgId: 'org-1', teamId: 'team-1' },
    tracer: { addActivityEvent: vi.fn() } as unknown as AgentTracer,
    workspace: { containerId: 'workspace-1' } as never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveSetting.mockResolvedValue('mastra');
  // The real resolver's default branch, so these tests can drive the choice
  // through the setting; resolveAgentRuntime has its own tests.
  h.resolveAgentRuntime.mockImplementation(async (_key: string, ctx: unknown) => ({
    runtime: await h.resolveSetting('workspace.implementerRuntime', ctx),
    source: 'default',
  }));
  h.resolveAgent.mockResolvedValue({
    model: { apiBase: 'https://gw.example/v1', apiKey: 'k', spec: 'anthropic/claude-opus-5-5' },
  });
  h.buildImplementerForActivity.mockResolvedValue({
    agent: { generate: h.generate },
    closeMcp: h.closeMcp,
    maxSteps: 42,
    promptSuffix: MENU,
    skills,
    toolKeys: ['readFile', 'mcp'],
  });
  h.resolveImplementerConfig.mockResolvedValue({
    maxSteps: 42,
    maxToolOutputChars: 20_000,
    skills,
    toolKeys: null,
  });
});

describe('buildImplementerTurnRunner', () => {
  it('reads the run-pinned setting in the caller’s scope before building anything', async () => {
    const ctx = { orgId: 'o', pinnedSettings: { 'workspace.implementerRuntime': 'mastra' } };
    h.resolveSetting.mockImplementation(async () => {
      expect(h.buildImplementerForActivity).not.toHaveBeenCalled();
      expect(h.resolveImplementerConfig).not.toHaveBeenCalled();
      return 'mastra';
    });
    await buildImplementerTurnRunner(input({ ctx }));
    expect(h.resolveSetting).toHaveBeenCalledWith('workspace.implementerRuntime', ctx);
  });

  it('asks for the agent’s own runtime, defaulting to the setting', async () => {
    const given = input({ agentKey: 'ciFixer' });
    await buildImplementerTurnRunner(given);
    expect(h.resolveAgentRuntime).toHaveBeenCalledWith('ciFixer', given.ctx, 'implementerSetting');
  });

  it('runs the harness for an agent that asks for it, whatever the setting says', async () => {
    h.resolveAgentRuntime.mockResolvedValue({ runtime: 'claude-code', source: 'agent' });
    const given = input();
    const turns = await buildImplementerTurnRunner(given);
    expect(h.claudeCodeRuntime).toHaveBeenCalledTimes(1);
    expect(h.buildImplementerForActivity).not.toHaveBeenCalled();
    expect(turns).toMatchObject({ kind: 'claude-code', kindSource: 'agent' });
    expect(given.tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'agent.runtime',
      outputJson: { agentKey: 'implementer', runtime: 'claude-code', source: 'agent' },
    });
  });

  it('keeps an agent on Mastra when it asks for it under a claude-code setting', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    h.resolveAgentRuntime.mockResolvedValue({ runtime: 'mastra', source: 'agent' });
    const turns = await buildImplementerTurnRunner(input());
    expect(h.claudeCodeRuntime).not.toHaveBeenCalled();
    expect(turns.kind).toBe('mastra');
  });

  it('passes the repository through, so the Mastra agent gets memory tools over its lessons', async () => {
    const given = { ...input({ agentKey: 'ciFixer' }), repoId: 'repo-9' };
    await buildImplementerTurnRunner(given);
    expect(h.buildImplementerForActivity).toHaveBeenCalledWith(
      given.workspace,
      given.tracer,
      given.ctx,
      'ciFixer',
      'repo-9'
    );
  });

  it('builds the Mastra agent, with its skill menu, only for the Mastra loop', async () => {
    const given = input({ agentKey: 'ciFixer' });
    const turns = await buildImplementerTurnRunner(given);

    expect(h.buildImplementerForActivity).toHaveBeenCalledWith(
      given.workspace,
      given.tracer,
      given.ctx,
      'ciFixer',
      undefined
    );
    expect(turns.promptSuffix).toBe(MENU);
    expect(turns.systemPrompt('BASE')).toBe(`BASE\n\n${MENU}`);
    expect(turns.maxSteps).toBe(42);
    expect(turns.toolKeys).toEqual(['readFile', 'mcp']);
    const outcome = await turns.runtime.runTurn({ system: 'S', user: 'U' });
    expect(outcome.text).toBe('mastra says hi');
    expect(h.generate.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 42 });
    expect(h.claudeCodeRuntime).not.toHaveBeenCalled();
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(turns.kind).toBe('mastra');
  });

  it('reports the runtime it built, so a caller can record what actually ran', async () => {
    expect((await buildImplementerTurnRunner(input())).kind).toBe('mastra');
    h.resolveSetting.mockResolvedValue('claude-code');
    expect((await buildImplementerTurnRunner(input())).kind).toBe('claude-code');
  });

  it('defaults to the implementer agent', async () => {
    await buildImplementerTurnRunner(input());
    expect(h.buildImplementerForActivity.mock.calls[0]?.[3]).toBe('implementer');
  });

  it('closes the MCP client once, however often close is called', async () => {
    const turns = await buildImplementerTurnRunner(input());
    await turns.close();
    await turns.close();
    expect(h.closeMcp).toHaveBeenCalledTimes(1);
  });

  it('under the harness, opens no MCP client and binds no Mastra model', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const turns = await buildImplementerTurnRunner(input());
    expect(h.buildImplementerForActivity).not.toHaveBeenCalled();
    await expect(turns.close()).resolves.toBeUndefined();
  });

  it('builds the harness on the Agent’s own model, credential and config', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const given = input({ agentKey: 'ciFixer' });

    const turns = await buildImplementerTurnRunner(given);

    expect(turns.runtime).toBe(h.claudeCodeRuntime.mock.results[0]?.value);
    expect(h.resolveAgent).toHaveBeenCalledWith('ciFixer', given.ctx);
    expect(h.resolveImplementerConfig).toHaveBeenCalledWith(given.ctx, 'ciFixer');
    expect(h.claudeCodeRuntime).toHaveBeenCalledWith({
      access: { apiBase: 'https://gw.example/v1', apiKey: 'k', modelId: 'claude-opus-5-5' },
      loadProjectSettings: true,
      maxTurns: 42,
      toolKeys: null,
      tracer: given.tracer,
      workspace: given.workspace,
    });
  });

  it('passes the persona-narrowed tool keys through to the harness', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    // What resolveImplementerConfig returns for a persona: its own keys intersected
    // with the implementer's (effectivePersonaToolKeys).
    h.resolveImplementerConfig.mockResolvedValue({
      maxSteps: 42,
      maxToolOutputChars: 20_000,
      skills,
      toolKeys: ['readFile', 'listDirectory'],
    });

    const turns = await buildImplementerTurnRunner(input({ agentKey: 'reviewFixer' }));

    expect(h.claudeCodeRuntime.mock.calls[0]?.[0]).toMatchObject({
      toolKeys: ['readFile', 'listDirectory'],
    });
    expect(turns.toolKeys).toEqual(['readFile', 'listDirectory']);
  });

  it('inlines each skill’s text for the harness, which has no loadSkill tool', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const turns = await buildImplementerTurnRunner(input());
    expect(turns.promptSuffix).toBe('Write the test first.\n\nKeep diffs small.');
    expect(turns.promptSuffix).not.toContain('loadSkill');
  });

  it('has no suffix for the harness when the agent has no skills', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    h.resolveImplementerConfig.mockResolvedValue({
      maxSteps: 42,
      maxToolOutputChars: 20_000,
      skills: [],
      toolKeys: null,
    });
    const turns = await buildImplementerTurnRunner(input());
    expect(turns.promptSuffix).toBe('');
    expect(turns.systemPrompt('BASE')).toBe('BASE');
  });

  it('refuses, without retrying, a model the harness cannot speak to', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    h.resolveAgent.mockResolvedValue({
      model: { apiKey: 'k', spec: 'openai/gpt-6.1-sol' },
    });

    await expect(buildImplementerTurnRunner(input())).rejects.toMatchObject({
      message: expect.stringContaining("'openai/gpt-6.1-sol'"),
      nonRetryable: true,
      type: 'HARNESS_UNSUPPORTED_MODEL',
    });
    expect(h.claudeCodeRuntime).not.toHaveBeenCalled();
  });

  it('omits the base URL when the credential has none', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    h.resolveAgent.mockResolvedValue({
      model: { apiBase: null, apiKey: 'k', spec: 'anthropic/claude-sonnet-5-5' },
    });
    await buildImplementerTurnRunner(input());
    expect(h.claudeCodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { apiBase: undefined, apiKey: 'k', modelId: 'claude-sonnet-5-5' },
      })
    );
  });
});
