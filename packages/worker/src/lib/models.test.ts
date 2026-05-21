import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirstMock, credFindFirstMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn().mockResolvedValue(null),
  findFirstMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    modelRoleConfig: { findFirst: findFirstMock },
    providerCredential: { findFirst: credFindFirstMock },
  },
}));

import { _resetConfigCacheForTests } from './config/cache.js';
import {
  _resetModelCacheForTests,
  type AgentRole,
  getModel,
  getModelSpec,
  resolveModel,
} from './models.js';

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

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  _resetConfigCacheForTests();
  _resetModelCacheForTests();
  findFirstMock.mockReset().mockResolvedValue(null);
  credFindFirstMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getModelSpec', () => {
  beforeEach(() => {
    for (const v of Object.values(ROLE_ENV)) delete process.env[v];
  });

  it('falls back to anthropic defaults when no DB row and no env override', async () => {
    for (const role of ROLES) {
      _resetConfigCacheForTests();
      expect(await getModelSpec(role)).toMatch(/^anthropic\//);
    }
  });

  it('honours the env override for each role when DB is empty', async () => {
    for (const role of ROLES) {
      _resetConfigCacheForTests();
      process.env[ROLE_ENV[role]] = 'openai/gpt-5';
      expect(await getModelSpec(role)).toBe('openai/gpt-5');
      delete process.env[ROLE_ENV[role]];
    }
  });

  it('treats whitespace-only env values as unset', async () => {
    process.env.IMPLEMENTER_MODEL = '   ';
    expect(await getModelSpec('implementer')).toMatch(/^anthropic\//);
  });

  it('uses the DB row when present', async () => {
    findFirstMock.mockResolvedValue({ credential: null, modelSpec: 'openai/gpt-from-db' });
    expect(await getModelSpec('implementer')).toBe('openai/gpt-from-db');
  });
});

describe('resolveModel', () => {
  it('builds Anthropic models from env', () => {
    const m = resolveModel('anthropic/claude-opus-4-6');
    expect(m.provider).toMatch(/anthropic/);
  });

  it('builds OpenAI models from env', () => {
    const m = resolveModel('openai/gpt-5');
    expect(m.provider).toMatch(/openai/);
  });

  it('builds Google models from env', () => {
    const m = resolveModel('google/gemini-2.5-pro');
    expect(m.provider).toMatch(/google/);
  });

  it('builds Anthropic models with an explicit apiKey override', () => {
    const m = resolveModel('anthropic/claude-opus-4-6', 'sk-ant-override');
    expect(m.provider).toMatch(/anthropic/);
    expect(m.modelId).toBe('claude-opus-4-6');
  });

  it('matches built-in providers case-insensitively', () => {
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

  it('uses an explicit apiBase override for unknown providers (no env required)', () => {
    delete process.env.OPENCODEGO_API_BASE;
    const m = resolveModel('opencodego/glm-5', 'sk-go', 'https://opencode.ai/zen/go/v1');
    expect(m.modelId).toBe('glm-5');
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
});

describe('getModel', () => {
  it('returns a model for every defined role', async () => {
    for (const role of ROLES) {
      _resetConfigCacheForTests();
      _resetModelCacheForTests();
      const m = await getModel(role);
      expect(m).toBeDefined();
      expect(typeof m.modelId).toBe('string');
    }
  });

  it('uses a DB-backed credential when one is configured', async () => {
    findFirstMock.mockResolvedValue({
      credential: null,
      modelSpec: 'anthropic/claude-opus-4-7',
    });
    credFindFirstMock.mockImplementation(async () => null);
    const m = await getModel('implementer');
    expect(m.provider).toMatch(/anthropic/);
  });
});
