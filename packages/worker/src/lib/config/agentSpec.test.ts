import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Mock the DB so importing agentSkills (for the real skillsToPromptSuffix) does
// not instantiate a live Prisma client.
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

vi.mock('../models.js', () => ({
  resolveModel: vi.fn((spec: string, apiKey: string, apiBase?: string) => ({
    apiBase,
    apiKey,
    sentinel: 'model',
    spec,
  })),
}));

// resolveAgentSpec's role path now resolves through the P1 Agent overlay.
vi.mock('./agentResolver.js', () => ({ resolveAgent: vi.fn() }));

import { resolveAgent } from './agentResolver.js';
import type { ResolvedSkill } from './agentSkills.js';
import { type AgentTools, resolveAgentSpec } from './agentSpec.js';

const mockedResolveAgent = vi.mocked(resolveAgent);

function skill(name: string, promptText: string, sortOrder = 0): ResolvedSkill {
  return { description: `${name} desc`, id: name, isVerified: true, name, promptText, sortOrder };
}

type ResolvedAgent = Awaited<ReturnType<typeof resolveAgent>>;

function resolvedAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    isVerified: true,
    key: 'validateContext',
    model: {
      apiBase: undefined,
      apiKey: 'secret-key',
      scope: 'GLOBAL',
      spec: 'anthropic/claude-x',
      systemPrompt: undefined,
    },
    origin: null,
    skills: [],
    toolKeys: null,
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveAgent.mockResolvedValue(resolvedAgent());
});

describe('resolveAgentSpec — role path', () => {
  it('composes base prompt + skill suffix exactly like the legacy per-call path', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({ skills: [skill('s1', 'SK1'), skill('s2', 'SK2')] })
    );

    const spec = await resolveAgentSpec({ agentKey: 'validateContext', basePrompt: 'BASE' });

    expect(spec.systemPrompt).toBe('BASE\n\nSK1\n\nSK2');
    expect(spec.modelSpec).toBe('anthropic/claude-x');
    expect(spec.agentKey).toBe('validateContext');
    expect(spec.skills).toHaveLength(2);
    expect(spec.model).toMatchObject({ sentinel: 'model', spec: 'anthropic/claude-x' });
  });

  it('binds the model from the resolved spec + credential', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({
        model: {
          apiBase: 'https://base',
          apiKey: 'k2',
          scope: 'GLOBAL',
          spec: 'openrouter/foo',
          systemPrompt: undefined,
        },
      })
    );
    const { resolveModel } = await import('../models.js');

    await resolveAgentSpec({ agentKey: 'reviewer', basePrompt: 'B' });

    expect(resolveModel).toHaveBeenCalledWith('openrouter/foo', 'k2', 'https://base');
  });

  it('returns the base prompt unchanged when there are no skills', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ skills: [] }));
    const spec = await resolveAgentSpec({ agentKey: 'planner', basePrompt: 'ONLY_BASE' });
    expect(spec.systemPrompt).toBe('ONLY_BASE');
  });

  it('prefers the resolved Agent prompt over the fallback base prompt', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({
        model: {
          apiBase: undefined,
          apiKey: 'k',
          scope: 'GLOBAL',
          spec: 'anthropic/claude-x',
          systemPrompt: 'DB_PROMPT',
        },
      })
    );
    const spec = await resolveAgentSpec({ agentKey: 'planner', basePrompt: 'BASE' });
    expect(spec.systemPrompt).toBe('DB_PROMPT');
  });

  it('lets an explicit promptOverride win over both Agent prompt and base', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({
        model: {
          apiBase: undefined,
          apiKey: 'k',
          scope: 'GLOBAL',
          spec: 'anthropic/claude-x',
          systemPrompt: 'DB_PROMPT',
        },
      })
    );
    const spec = await resolveAgentSpec({
      agentKey: 'planner',
      basePrompt: 'BASE',
      promptOverride: 'OVERRIDE',
    });
    expect(spec.systemPrompt).toBe('OVERRIDE');
  });

  it('attaches an outputSchema when given', async () => {
    const schema = z.object({ ok: z.boolean() });
    const spec = await resolveAgentSpec({
      agentKey: 'validateContext',
      basePrompt: 'B',
      outputSchema: schema,
    });
    expect(spec.outputSchema).toBe(schema);
  });
});

describe('resolveAgentSpec — tool selection', () => {
  const tools = {
    bash: 't-bash',
    readFile: 't-read',
    writeFile: 't-write',
  } as unknown as AgentTools;

  it('returns no tools when none are offered', async () => {
    const spec = await resolveAgentSpec({ agentKey: 'validateContext', basePrompt: 'B' });
    expect(spec.tools).toEqual({});
  });

  it('returns every candidate when the agent has no tool override (null)', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ toolKeys: null }));
    const spec = await resolveAgentSpec({
      agentKey: 'implementer',
      availableTools: tools,
      basePrompt: 'B',
    });
    expect(spec.tools).toBe(tools);
  });

  it('intersects candidates with the enabled-tool keys', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({ toolKeys: ['readFile', 'bash', 'missingTool'] })
    );
    const spec = await resolveAgentSpec({
      agentKey: 'implementer',
      availableTools: tools,
      basePrompt: 'B',
    });
    expect(spec.tools).toEqual({ bash: 't-bash', readFile: 't-read' });
  });
});

describe('resolveAgentSpec — inline path', () => {
  it('binds an inline spec without touching the Agent resolver', async () => {
    const schema = z.object({ x: z.number() });
    const spec = await resolveAgentSpec({
      inline: {
        apiBase: 'https://b',
        apiKey: 'ik',
        modelSpec: 'google/gemini-x',
        outputSchema: schema,
        systemPrompt: 'INLINE_SYS',
      },
    });

    expect(mockedResolveAgent).not.toHaveBeenCalled();
    expect(spec.agentKey).toBe('inlineAgent');
    expect(spec.systemPrompt).toBe('INLINE_SYS');
    expect(spec.modelSpec).toBe('google/gemini-x');
    expect(spec.outputSchema).toBe(schema);
    expect(spec.skills).toEqual([]);
    expect(spec.tools).toEqual({});
    expect(spec.model).toMatchObject({
      apiBase: 'https://b',
      apiKey: 'ik',
      spec: 'google/gemini-x',
    });
  });

  it('honors a supplied inline agentKey', async () => {
    const spec = await resolveAgentSpec({
      inline: { apiKey: 'k', modelSpec: 'openai/gpt', systemPrompt: 'S' },
    });
    expect(spec.agentKey).toBe('inlineAgent');
    const spec2 = await resolveAgentSpec({
      inline: { agentKey: 'customAgent', apiKey: 'k', modelSpec: 'openai/gpt', systemPrompt: 'S' },
    });
    expect(spec2.agentKey).toBe('customAgent');
  });
});
