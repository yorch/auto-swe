import { generateText } from 'ai';
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
    id: 'agent-row-1',
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
    // A deterministic config error: retrying the activity cannot cure it.
    try {
      resolveModel('mystery/some-model', 'sk-x');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ nonRetryable: true, type: 'MODEL_CONFIG_INVALID' });
    }
  });

  it('rejects malformed specs', () => {
    expect(() => resolveModel('claude-opus-4-6', 'sk-x')).toThrow(/provider.*model/i);
    expect(() => resolveModel('/foo', 'sk-x')).toThrow();
    expect(() => resolveModel('foo/', 'sk-x')).toThrow();
  });
});

describe('resolveModel — reasoning', () => {
  it('binds a level into a separately cached model, and none for no opinion', () => {
    const plain = resolveModel('anthropic/claude-opus-5-5', 'sk-r');
    expect(resolveModel('anthropic/claude-opus-5-5', 'sk-r', undefined, null)).toBe(plain);
    const high = resolveModel('anthropic/claude-opus-5-5', 'sk-r', undefined, 'high');
    expect(high).not.toBe(plain);
    expect(resolveModel('anthropic/claude-opus-5-5', 'sk-r', undefined, 'high')).toBe(high);
    expect(high.modelId).toBe('claude-opus-5-5');
  });

  it('leaves an OpenAI-compatible model unwrapped, whatever the level', () => {
    const plain = resolveModel('ollama/llama-4', 'sk-x', 'http://localhost:11434/v1');
    expect(resolveModel('ollama/llama-4', 'sk-x', 'http://localhost:11434/v1', 'high')).toBe(plain);
  });
});

describe('resolveModel — what a reasoning level puts on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The JSON body the bound model sends for one call. */
  async function bodyOf(
    spec: string,
    level: Parameters<typeof resolveModel>[3],
    apiBase?: string
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        // A refusal is enough: the request was built and captured.
        return new Response(JSON.stringify({ error: { message: 'stop', type: 'x' } }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        });
      })
    );
    const model = resolveModel(spec, 'sk-x', apiBase, level);
    await generateText({ maxRetries: 0, model, prompt: 'hi' }).catch(() => undefined);
    return body;
  }

  it('sends no reasoning_effort to OpenAI behind an apiBase, whatever the level', async () => {
    const body = await bodyOf('openai/gpt-5', 'high', 'https://litellm.example/v1');
    expect(body.model).toBe('gpt-5');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('sends nothing for off to an OpenAI model whose adapter does not list the none effort', async () => {
    for (const modelId of ['o3', 'gpt-5']) {
      const body = await bodyOf(`openai/${modelId}`, 'off');
      expect(body.model).toBe(modelId);
      expect(body).not.toHaveProperty('reasoning');
    }
  });

  it('sends effort none for off where the adapter lists it', async () => {
    const body = await bodyOf('openai/gpt-6-luna', 'off');
    expect(body.reasoning).toMatchObject({ effort: 'none' });
  });

  it('sends no thinking configuration for off to Google', async () => {
    for (const modelId of ['gemini-2.5-pro', 'gemini-3.1-pro-preview']) {
      const body = await bodyOf(`google/${modelId}`, 'off');
      expect(body.contents).toBeDefined();
      const config = body.generationConfig as Record<string, unknown> | undefined;
      expect(config?.thinkingConfig).toBeUndefined();
    }
  });

  it('sends no thinking budget to a Google model that cannot think', async () => {
    for (const [modelId, level] of [
      ['gemini-2.0-flash', 'low'],
      ['gemma-3-27b-it', 'high'],
    ] as const) {
      const body = await bodyOf(`google/${modelId}`, level);
      expect(body.contents).toBeDefined();
      const config = body.generationConfig as Record<string, unknown> | undefined;
      expect(config?.thinkingConfig).toBeUndefined();
    }
  });

  it('still sends a thinking budget to a Gemini 2.5 model', async () => {
    const body = await bodyOf('google/gemini-2.5-flash', 'low');
    const config = body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    expect(config.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
  });

  it('sends no thinking to an Anthropic model that predates extended thinking', async () => {
    for (const level of ['low', 'off'] as const) {
      const body = await bodyOf('anthropic/claude-3-haiku-20240307', level);
      expect(body.model).toBe('claude-3-haiku-20240307');
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('output_config');
    }
  });

  it('still sends adaptive thinking at the effort to a current Anthropic model', async () => {
    const body = await bodyOf('anthropic/claude-opus-5-5', 'high');
    expect(body.thinking).toMatchObject({ type: 'adaptive' });
    expect(body.output_config).toMatchObject({ effort: 'high' });
  });

  it('still sends a level the model takes', async () => {
    expect((await bodyOf('openai/o3', 'high')).reasoning).toMatchObject({ effort: 'high' });
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

describe('resolveModel — SSRF guard', () => {
  it('refuses a call to an internal apiBase no admin listed, before any request', async () => {
    const stub = vi.fn();
    vi.stubGlobal('fetch', stub);
    const m = resolveModel('vllm/llama-4', 'sk-x', 'http://10.0.0.5:8000/v1');
    await expect(
      m.doGenerate({ prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }] })
    ).rejects.toThrow(/10\.0\.0\.5|blocked|private/i);
    expect(stub).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it('returns the id and version of the resolved Agent row, for the trace rows it writes', async () => {
    mockedResolveAgent.mockResolvedValue(resolvedAgent());
    expect((await getBoundModel('implementer')).agent).toEqual({ id: 'agent-row-1', version: 1 });
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
