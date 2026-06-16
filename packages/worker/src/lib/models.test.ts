import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

// models.ts now resolves through the Agent entity. Mock resolveAgent.
vi.mock('./config/agentResolver.js', () => ({ resolveAgent: vi.fn() }));

import { resolveAgent } from './config/agentResolver.js';
import { _resetConfigCacheForTests } from './config/cache.js';
import { ConfigMissingError } from './config/resolver.js';
import {
  _resetModelCacheForTests,
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
