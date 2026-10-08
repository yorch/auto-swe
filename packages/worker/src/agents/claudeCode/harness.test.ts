import { describe, expect, it } from 'vitest';
import { claudeCodeHarness } from './harness.js';

const model = (spec: string) => ({ apiKey: 'sk-ant', spec });

describe('claudeCodeHarness.bind', () => {
  it('binds an Anthropic model, whatever the provider’s capitalisation', () => {
    expect(() =>
      claudeCodeHarness.bind('implementer', model('anthropic/claude-opus-5-5'))
    ).not.toThrow();
    expect(() =>
      claudeCodeHarness.bind('implementer', model('Anthropic/claude-opus-5-5'))
    ).not.toThrow();
  });

  it('refuses any other provider, Anthropic models routed through one included', () => {
    expect(() =>
      claudeCodeHarness.bind('implementer', model('openrouter/anthropic/claude-opus-5-5'))
    ).toThrow(/needs an Anthropic model/);
  });
});
