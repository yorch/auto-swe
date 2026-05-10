import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentRole, getModel, getModelSpec, resolveModel } from './models.js';

const ROLES: AgentRole[] = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
];

const ROLE_ENV: Record<AgentRole, string> = {
  commitToMemory: 'MEMORY_SUMMARIZER_MODEL',
  implementer: 'IMPLEMENTER_MODEL',
  planner: 'PLANNER_MODEL',
  reviewer: 'REVIEWER_MODEL',
  securityReview: 'SECURITY_REVIEW_MODEL',
  validateContext: 'CONTEXT_VALIDATOR_MODEL',
};

describe('getModelSpec', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const v of Object.values(ROLE_ENV)) delete process.env[v];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back to anthropic defaults when no env override is set', () => {
    for (const role of ROLES) {
      expect(getModelSpec(role)).toMatch(/^anthropic\//);
    }
  });

  it('honours the env override for each role', () => {
    for (const role of ROLES) {
      process.env[ROLE_ENV[role]] = 'openai/gpt-5';
      expect(getModelSpec(role)).toBe('openai/gpt-5');
      delete process.env[ROLE_ENV[role]];
    }
  });

  it('treats whitespace-only env values as unset', () => {
    process.env.IMPLEMENTER_MODEL = '   ';
    expect(getModelSpec('implementer')).toMatch(/^anthropic\//);
  });
});

describe('resolveModel', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds Anthropic models', () => {
    const m = resolveModel('anthropic/claude-opus-4-6');
    expect(m.provider).toMatch(/anthropic/);
  });

  it('builds OpenAI models', () => {
    const m = resolveModel('openai/gpt-5');
    expect(m.provider).toMatch(/openai/);
  });

  it('builds Google models', () => {
    const m = resolveModel('google/gemini-2.5-pro');
    expect(m.provider).toMatch(/google/);
  });

  it('matches built-in providers case-insensitively', () => {
    // Without normalisation `OpenAI/gpt-5` would fall through to the
    // OpenAI-compatible path and fail with a misleading "Set OPENAI_API_BASE".
    expect(resolveModel('OpenAI/gpt-5').provider).toMatch(/openai/);
    expect(resolveModel('ANTHROPIC/claude-opus-4-6').provider).toMatch(/anthropic/);
    expect(resolveModel('Google/gemini-2.5-pro').provider).toMatch(/google/);
  });

  it('preserves model id casing (some self-hosted endpoints are case-sensitive)', () => {
    process.env.OLLAMA_API_BASE = 'http://localhost:11434/v1';
    const m = resolveModel('ollama/MyCustomModel:Latest');
    expect(m.modelId).toBe('MyCustomModel:Latest');
  });

  it('preserves slashes in the model id (OpenRouter-style)', () => {
    process.env.OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
    process.env.OPENROUTER_API_KEY = 'test';
    const m = resolveModel('openrouter/anthropic/claude-opus-4-6');
    expect(m.modelId).toBe('anthropic/claude-opus-4-6');
  });

  it('routes unknown providers through OpenAI-compatible when API base is set', () => {
    process.env.OLLAMA_API_BASE = 'http://localhost:11434/v1';
    const m = resolveModel('ollama/llama3.1:70b');
    expect(m.modelId).toBe('llama3.1:70b');
  });

  it('throws on unknown provider when no API base is configured', () => {
    delete process.env.MYSTERY_API_BASE;
    expect(() => resolveModel('mystery/some-model')).toThrow(/MYSTERY_API_BASE/);
  });

  it('rejects malformed specs', () => {
    expect(() => resolveModel('claude-opus-4-6')).toThrow(/provider.*model/i);
    expect(() => resolveModel('/foo')).toThrow();
    expect(() => resolveModel('foo/')).toThrow();
  });

  it('uppercases and normalises hyphens in provider env-var lookup', () => {
    process.env.MY_GATEWAY_API_BASE = 'https://gw.example.com/v1';
    const m = resolveModel('my-gateway/some-model');
    expect(m.modelId).toBe('some-model');
  });
});

describe('getModel', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a model for every defined role', () => {
    for (const role of ROLES) {
      const m = getModel(role);
      expect(m).toBeDefined();
      expect(typeof m.modelId).toBe('string');
    }
  });
});
