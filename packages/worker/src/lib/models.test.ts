import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

// models.ts now resolves through the Agent entity. Mock resolveAgent.
vi.mock('./config/agentResolver.js', () => ({ resolveAgent: vi.fn() }));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { resolveAgent } from './config/agentResolver.js';
import { ConfigMissingError } from './config/resolver.js';
import {
  _resetModelCacheForTests,
  getBoundModel,
  getModel,
  getModelSpec,
  resolveModel,
  resolveSystemPrompt,
} from './models.js';

const mockedResolveAgent = vi.mocked(resolveAgent);

type ResolvedAgent = Awaited<ReturnType<typeof resolveAgent>>;

function resolvedAgent(modelOverrides: Record<string, unknown> = {}): ResolvedAgent {
  return {
    isVerified: true,
    key: 'implementer',
    mcpConnectionId: null,
    model: {
      apiBase: undefined,
      apiKey: 'sk-ant-x',
      scope: 'GLOBAL',
      spec: 'anthropic/claude-opus-4-6',
      systemPrompt: undefined,
      ...modelOverrides,
    },
    origin: null,
    runtime: null,
    skills: [],
    toolKeys: null,
    version: 1,
  };
}

beforeEach(() => {
  _resetConfigCacheForTests();
  _resetModelCacheForTests();
  mockedResolveAgent.mockReset();
});

afterEach(() => {
  _resetConfigCacheForTests();
});

describe('getModelSpec', () => {
  it('throws ConfigMissingError when the Agent does not resolve', async () => {
    mockedResolveAgent.mockRejectedValue(new ConfigMissingError('no agent'));
    await expect(getModelSpec('implementer')).rejects.toThrow(ConfigMissingError);
  });

  it('returns the resolved Agent model spec', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent());
    await expect(getModelSpec('implementer')).resolves.toBe('anthropic/claude-opus-4-6');
  });
});

describe('resolveModel', () => {
  it('builds Anthropic models with an explicit apiKey', () => {
    const m = resolveModel('anthropic/claude-opus-4-6', 'sk-ant-x');
    expect(m.provider).toMatch(/anthropic/);
    expect(m.modelId).toBe('claude-opus-4-6');
  });

  it('builds OpenAI models with an explicit apiKey', () => {
    const m = resolveModel('openai/gpt-5', 'sk-openai-x');
    expect(m.provider).toMatch(/openai/);
  });

  it('builds Google models with an explicit apiKey', () => {
    const m = resolveModel('google/gemini-2.5-pro', 'sk-google-x');
    expect(m.provider).toMatch(/google/);
  });

  it('matches built-in providers case-insensitively', () => {
    expect(resolveModel('OpenAI/gpt-5', 'sk-x').provider).toMatch(/openai/);
    expect(resolveModel('ANTHROPIC/claude-opus-4-6', 'sk-x').provider).toMatch(/anthropic/);
    expect(resolveModel('Google/gemini-2.5-pro', 'sk-x').provider).toMatch(/google/);
  });

  it('preserves model id casing (some self-hosted endpoints are case-sensitive)', () => {
    const m = resolveModel('ollama/MyCustomModel:Latest', 'sk-x', 'http://localhost:11434/v1');
    expect(m.modelId).toBe('MyCustomModel:Latest');
  });

  it('preserves slashes in the model id (OpenRouter-style)', () => {
    const m = resolveModel(
      'openrouter/anthropic/claude-opus-4-6',
      'sk-x',
      'https://openrouter.ai/api/v1'
    );
    expect(m.modelId).toBe('anthropic/claude-opus-4-6');
  });

  it('uses an explicit apiBase for unknown providers', () => {
    const m = resolveModel('opencodego/glm-5', 'sk-go', 'https://opencode.ai/zen/go/v1');
    expect(m.modelId).toBe('glm-5');
  });

  it('throws on unknown provider when no apiBase is supplied', () => {
    expect(() => resolveModel('mystery/some-model', 'sk-x')).toThrow(/apiBase/);
  });

  it('rejects malformed specs', () => {
    expect(() => resolveModel('claude-opus-4-6', 'sk-x')).toThrow(/provider.*model/i);
    expect(() => resolveModel('/foo', 'sk-x')).toThrow();
    expect(() => resolveModel('foo/', 'sk-x')).toThrow();
  });
});

describe('resolveModel — OpenAI with a custom base', () => {
  it('uses the Responses API against OpenAI itself', () => {
    expect(resolveModel('openai/gpt-6-luna', 'sk-x').provider).toBe('openai.responses');
  });

  it('uses Chat Completions behind a proxy or gateway apiBase', () => {
    const m = resolveModel('openai/gpt-6-luna', 'sk-x', 'https://litellm.internal/v1');
    expect(m.provider).toBe('openai.chat');
    expect(m.modelId).toBe('gpt-6-luna');
  });
});

describe('resolveModel — OpenAI-compatible structured output', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the response schema in the system prompt, since the adapter drops it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                index: 0,
                message: { content: '{"ok":true}', role: 'assistant' },
              },
            ],
            created: 0,
            id: 'x',
            model: 'glm-5.2',
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      })
    );
    const m = resolveModel('opencode-go/glm-5.2', 'sk-go', 'https://example.test/v1');
    await m.doGenerate({
      prompt: [
        { content: 'You review code.', role: 'system' },
        { content: [{ text: 'Review this.', type: 'text' }], role: 'user' },
      ],
      responseFormat: {
        schema: { properties: { ok: { type: 'boolean' } }, required: ['ok'], type: 'object' },
        type: 'json',
      },
    });

    const messages = bodies[0]?.messages as Array<{ content: string; role: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toMatch(/^You review code\./);
    expect(messages[0]?.content).toContain('"required":["ok"]');
    expect(bodies[0]?.response_format).toEqual({ type: 'json_object' });
  });
});

describe('resolveModel — client cache', () => {
  it('reuses the client for the same spec, key and base', () => {
    const a = resolveModel('openrouter/x', 'sk-same-123456', 'https://openrouter.ai/api/v1');
    const b = resolveModel('openrouter/x', 'sk-same-123456', 'https://openrouter.ai/api/v1');
    expect(a).toBe(b);
  });

  it('never shares a client between two keys that end the same way', () => {
    const a = resolveModel('openrouter/x', 'sk-team-a-123456', 'https://openrouter.ai/api/v1');
    const b = resolveModel('openrouter/x', 'sk-team-b-123456', 'https://openrouter.ai/api/v1');
    expect(a).not.toBe(b);
  });
});

describe('getModel', () => {
  it('throws ConfigMissingError when the Agent does not resolve', async () => {
    mockedResolveAgent.mockRejectedValue(new ConfigMissingError('no agent'));
    await expect(getModel('implementer')).rejects.toThrow(ConfigMissingError);
  });

  it('builds a model from the resolved Agent', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent());
    const m = await getModel('implementer');
    expect(m.modelId).toBe('claude-opus-4-6');
  });
});

describe('getBoundModel', () => {
  it('returns the spec of the very agent the model was built from', async () => {
    mockedResolveAgent.mockResolvedValue(
      resolvedAgent({ spec: 'anthropic/claude-haiku-4-5-20251001' })
    );
    const bound = await getBoundModel('commitToMemory');
    expect(bound.spec).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(bound.model.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('returns the prompt of the same resolution, null when the row sets none', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ systemPrompt: 'row prompt' }));
    expect((await getBoundModel('planner')).systemPrompt).toBe('row prompt');
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ systemPrompt: null }));
    expect((await getBoundModel('planner')).systemPrompt).toBeNull();
  });

  it('resolves once, at the explicit ctx (the CHANNEL tier the ambient context cannot supply)', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent());
    await getBoundModel('commitToMemory', { channelId: 'chan-1', orgId: 'o', teamId: 't' });
    expect(mockedResolveAgent).toHaveBeenCalledTimes(1);
    expect(mockedResolveAgent).toHaveBeenCalledWith(
      'commitToMemory',
      expect.objectContaining({ channelId: 'chan-1', orgId: 'o', teamId: 't' })
    );
  });
});

describe('resolveSystemPrompt', () => {
  it('returns configOverride immediately without resolving the Agent', async () => {
    const result = await resolveSystemPrompt('implementer', 'default prompt', 'override prompt');
    expect(result).toBe('override prompt');
    expect(mockedResolveAgent).not.toHaveBeenCalled();
  });

  it("returns the Agent's systemPrompt when set", async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ systemPrompt: 'db prompt' }));
    const result = await resolveSystemPrompt('implementer', 'default prompt');
    expect(result).toBe('db prompt');
  });

  it('falls back to the hardcoded constant when the Agent has no systemPrompt', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent({ systemPrompt: undefined }));
    const result = await resolveSystemPrompt('implementer', 'default prompt');
    expect(result).toBe('default prompt');
  });
});
