import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 hoists `vi.mock()` factories above ALL imports/top-level code.
// Any variable the factory closes over MUST also be hoisted via `vi.hoisted()`.
const { embedMock, openaiEmbeddingFactory, openaiCompatTextEmbeddingFactory } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  openaiCompatTextEmbeddingFactory: vi.fn(),
  openaiEmbeddingFactory: vi.fn(),
}));

vi.mock('ai', () => ({
  embed: embedMock,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ embedding: openaiEmbeddingFactory })),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => ({ textEmbeddingModel: openaiCompatTextEmbeddingFactory })),
}));

import { _resetEmbeddingClientForTests, generateEmbedding } from './embeddings.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  embedMock.mockReset();
  openaiEmbeddingFactory.mockReset();
  openaiCompatTextEmbeddingFactory.mockReset();
  openaiEmbeddingFactory.mockReturnValue({ tag: 'openai-embed' });
  openaiCompatTextEmbeddingFactory.mockReturnValue({ tag: 'compat-embed' });
  _resetEmbeddingClientForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('generateEmbedding', () => {
  it('uses OpenAI text-embedding-3-large by default', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0.1) });

    const v = await generateEmbedding('hello world');

    expect(v).toHaveLength(1536);
    expect(openaiEmbeddingFactory).toHaveBeenCalledWith('text-embedding-3-large');
    expect(embedMock).toHaveBeenCalledWith({
      model: { tag: 'openai-embed' },
      providerOptions: { openai: { dimensions: 1536 } },
      value: 'hello world',
    });
  });

  it('errors with a clear message when OPENAI_API_KEY is missing for an OpenAI spec', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generateEmbedding('x')).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('routes unknown providers through OpenAI-compatible when API base is set', async () => {
    process.env.EMBEDDING_MODEL = 'ollama/nomic-embed-text';
    process.env.OLLAMA_API_BASE = 'http://localhost:11434/v1';
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0) });

    await generateEmbedding('hi');

    expect(openaiCompatTextEmbeddingFactory).toHaveBeenCalledWith('nomic-embed-text');
    // OpenAI-specific providerOptions (dimensions) must NOT be forwarded to non-OpenAI providers.
    expect(embedMock).toHaveBeenCalledWith({
      model: { tag: 'compat-embed' },
      value: 'hi',
    });
  });

  it('rejects unknown providers when no API base is configured', async () => {
    process.env.EMBEDDING_MODEL = 'mystery/foo';
    delete process.env.MYSTERY_API_BASE;
    await expect(generateEmbedding('x')).rejects.toThrow(/MYSTERY_API_BASE/);
  });

  it('rejects malformed embedding specs', async () => {
    process.env.EMBEDDING_MODEL = 'no-slash';
    await expect(generateEmbedding('x')).rejects.toThrow(/provider.*model/i);
  });

  it('throws when the embedding is too small for the pgvector column', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.EMBEDDING_MODEL;
    embedMock.mockResolvedValue({ embedding: new Array(768).fill(0) });
    await expect(generateEmbedding('x')).rejects.toThrow(/768.*1536/);
  });

  it('throws when the embedding is too large for the pgvector column', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.EMBEDDING_MODEL;
    embedMock.mockResolvedValue({ embedding: new Array(3072).fill(0) });
    await expect(generateEmbedding('x')).rejects.toThrow(/3072.*1536/);
  });
});
