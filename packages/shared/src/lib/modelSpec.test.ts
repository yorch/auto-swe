import { describe, expect, it } from 'vitest';
import {
  embeddingProviderProblem,
  isAnthropicSpec,
  normalizeModelSpec,
  parseProviderModelSpec,
} from './modelSpec.js';

describe('parseProviderModelSpec', () => {
  it('splits on the first slash, lowercasing only the provider', () => {
    expect(parseProviderModelSpec('OpenRouter/OpenAI/GPT-6-luna')).toEqual({
      modelId: 'OpenAI/GPT-6-luna',
      provider: 'openrouter',
    });
  });
});

describe('normalizeModelSpec', () => {
  it('lowercases and trims the provider and keeps the model id as written', () => {
    expect(normalizeModelSpec(' OpenAI /gpt-6-luna')).toBe('openai/gpt-6-luna');
    expect(normalizeModelSpec('ollama/MyModel:Latest')).toBe('ollama/MyModel:Latest');
  });

  it('throws on a spec with no provider or no model', () => {
    expect(() => normalizeModelSpec('gpt-6-luna')).toThrow(/provider/);
    expect(() => normalizeModelSpec('openai/ ')).toThrow();
  });
});

describe('isAnthropicSpec', () => {
  it('matches the provider case-insensitively and nothing else', () => {
    expect(isAnthropicSpec('anthropic/claude-opus-5-5')).toBe(true);
    expect(isAnthropicSpec('Anthropic/claude-opus-5-5')).toBe(true);
    expect(isAnthropicSpec('openrouter/anthropic/claude-opus-5-5')).toBe(false);
  });
});

describe('embeddingProviderProblem', () => {
  it('refuses only Anthropic', () => {
    expect(embeddingProviderProblem('anthropic')).toMatch(/no embedding models/);
    expect(embeddingProviderProblem('Anthropic')).toMatch(/no embedding models/);
    for (const provider of ['openai', 'google', 'openrouter', 'ollama']) {
      expect(embeddingProviderProblem(provider)).toBeNull();
    }
  });
});
