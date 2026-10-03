import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claudeCodeRuntime: vi.fn(() => ({ runTurn: vi.fn() })),
  resolveAgent: vi.fn(),
  resolveSetting: vi.fn(),
}));

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: h.resolveSetting }));
vi.mock('../lib/config/agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));
vi.mock('./claudeCode/runtime.js', () => ({ claudeCodeRuntime: h.claudeCodeRuntime }));

import type { AgentTracer } from '../lib/agentTracer.js';
import { selectImplementerRuntime } from './implementerRuntimeSelect.js';

const skills = [
  { description: 'd1', name: 'tdd', promptText: 'Write the test first.' },
  { description: 'd2', name: 'small', promptText: 'Keep diffs small.' },
] as never;

const generate = vi.fn(async (..._args: unknown[]) => ({
  text: 'mastra says hi',
  usage: undefined,
}));

function input(
  overrides: Record<string, unknown> = {}
): Parameters<typeof selectImplementerRuntime>[0] {
  return {
    agent: { generate } as never,
    agentKey: 'implementer',
    ctx: { orgId: 'org-1', teamId: 'team-1' },
    maxSteps: 42,
    promptSuffix: '## Available Skills\n- tdd: call loadSkill',
    skills,
    tracer: {} as AgentTracer,
    workspace: { containerId: 'workspace-1' } as never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveSetting.mockResolvedValue('mastra');
  h.resolveAgent.mockResolvedValue({
    model: { apiBase: 'https://gw.example/v1', apiKey: 'k', spec: 'anthropic/claude-opus-5-5' },
  });
});

describe('selectImplementerRuntime', () => {
  it('reads the run-pinned setting in the caller’s scope', async () => {
    const ctx = { orgId: 'o', pinnedSettings: { 'workspace.implementerRuntime': 'mastra' } };
    await selectImplementerRuntime(input({ ctx }));
    expect(h.resolveSetting).toHaveBeenCalledWith('workspace.implementerRuntime', ctx);
  });

  it('gives the Mastra loop and its own skill menu by default', async () => {
    const { promptSuffix, runtime } = await selectImplementerRuntime(input());

    expect(promptSuffix).toBe('## Available Skills\n- tdd: call loadSkill');
    const outcome = await runtime.runTurn({ system: 'S', user: 'U' });
    expect(outcome.text).toBe('mastra says hi');
    expect(generate.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 42 });
    expect(h.claudeCodeRuntime).not.toHaveBeenCalled();
    expect(h.resolveAgent).not.toHaveBeenCalled();
  });

  it('builds the harness on the Agent’s own model and credential when the setting says so', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const given = input({ agentKey: 'ciFixer' });

    const { runtime } = await selectImplementerRuntime(given);

    expect(runtime).toBe(h.claudeCodeRuntime.mock.results[0]?.value);
    expect(h.resolveAgent).toHaveBeenCalledWith('ciFixer', given.ctx);
    expect(h.claudeCodeRuntime).toHaveBeenCalledWith({
      access: { apiBase: 'https://gw.example/v1', apiKey: 'k', modelId: 'claude-opus-5-5' },
      loadProjectSettings: true,
      maxTurns: 42,
      tracer: given.tracer,
      workspace: given.workspace,
    });
  });

  it('inlines each skill’s text for the harness, which has no loadSkill tool', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const { promptSuffix } = await selectImplementerRuntime(input());
    expect(promptSuffix).toBe('Write the test first.\n\nKeep diffs small.');
    expect(promptSuffix).not.toContain('loadSkill');
  });

  it('has no suffix for the harness when the agent has no skills', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    const { promptSuffix } = await selectImplementerRuntime(input({ skills: [] }));
    expect(promptSuffix).toBe('');
  });

  it('refuses, without retrying, a model the harness cannot speak to', async () => {
    h.resolveSetting.mockResolvedValue('claude-code');
    h.resolveAgent.mockResolvedValue({
      model: { apiKey: 'k', spec: 'openai/gpt-6.1-sol' },
    });

    await expect(selectImplementerRuntime(input())).rejects.toMatchObject({
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
    await selectImplementerRuntime(input());
    expect(h.claudeCodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { apiBase: undefined, apiKey: 'k', modelId: 'claude-sonnet-5-5' },
      })
    );
  });
});
