import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirstMock, credFindFirstMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn().mockResolvedValue(null),
  findFirstMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: vi.fn() },
    modelRoleConfig: { findFirst: findFirstMock },
    providerCredential: { findFirst: credFindFirstMock },
  },
}));

import { _resetConfigCacheForTests } from './config/cache.js';
import { ConfigMissingError } from './config/resolver.js';
import { _resetModelCacheForTests, getModel, getModelSpec, resolveModel } from './models.js';

beforeEach(() => {
  _resetConfigCacheForTests();
  _resetModelCacheForTests();
  findFirstMock.mockReset().mockResolvedValue(null);
  credFindFirstMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  _resetConfigCacheForTests();
});

describe('getModelSpec', () => {
  it('throws ConfigMissingError when no GLOBAL row exists', async () => {
    findFirstMock.mockResolvedValue(null);
    await expect(getModelSpec('implementer')).rejects.toThrow(ConfigMissingError);
  });
  // Spec roundtrip with a real DB-decrypt path is covered end-to-end in
  // resolver.test.ts (uses vi.hoisted + encryptSecret to produce valid
  // ciphertext). No need to duplicate the setup here.
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
  it('throws ConfigMissingError when no DB config exists', async () => {
    findFirstMock.mockResolvedValue(null);
    await expect(getModel('implementer')).rejects.toThrow(ConfigMissingError);
  });
});
