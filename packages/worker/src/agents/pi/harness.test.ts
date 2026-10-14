import { describe, expect, it } from 'vitest';
import { piHarness } from './harness.js';

describe('piHarness.bind', () => {
  it('binds any model the worker’s own model binding serves', () => {
    for (const spec of [
      'anthropic/claude-opus-5-5',
      'OpenAI/gpt-6.1-sol',
      'google/gemini-3.8-flash',
    ]) {
      expect(() => piHarness.bind('implementer', { apiKey: 'k', spec })).not.toThrow();
    }
    expect(() =>
      piHarness.bind('implementer', {
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'k',
        spec: 'openrouter/anthropic/claude-opus-5-5',
      })
    ).not.toThrow();
  });

  it('refuses an OpenAI-compatible provider whose credential names no apiBase, before building anything', () => {
    expect(() => piHarness.bind('implementer', { apiKey: 'k', spec: 'ollama/llama-4' })).toThrow(
      expect.objectContaining({ nonRetryable: true, type: 'HARNESS_UNSUPPORTED_MODEL' })
    );
  });
});
