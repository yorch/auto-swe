import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { claudeCodeEffort, reasoningCallSetting, reasoningMiddleware } from './reasoning.js';

describe('reasoningCallSetting', () => {
  it('sends nothing for no opinion, so the provider default stands', () => {
    expect(reasoningCallSetting('anthropic/claude-opus-5-5', null)).toBeUndefined();
    expect(reasoningCallSetting('anthropic/claude-opus-5-5', undefined)).toBeUndefined();
  });

  it('passes low, medium and high through to the built-in providers', () => {
    for (const spec of [
      'anthropic/claude-opus-5-5',
      'OpenAI/gpt-6-astra',
      'openai/o3',
      'google/gemini-3.8-flash',
    ]) {
      expect(reasoningCallSetting(spec, 'low')).toBe('low');
      expect(reasoningCallSetting(spec, 'medium')).toBe('medium');
      expect(reasoningCallSetting(spec, 'high')).toBe('high');
    }
  });

  it('sends off as none only where the adapter knows the model takes it', () => {
    expect(reasoningCallSetting('anthropic/claude-opus-5-5', 'off')).toBe('none');
    expect(reasoningCallSetting('anthropic/claude-haiku-4-5-20251001', 'off')).toBe('none');
    expect(reasoningCallSetting('openai/gpt-6-luna', 'off')).toBe('none');
    expect(reasoningCallSetting('openai/gpt-6-sol', 'off')).toBe('none');
    for (const spec of [
      'openai/o3',
      'openai/gpt-5',
      'openai/gpt-6-astra',
      'google/gemini-2.5-pro',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.8-flash',
    ]) {
      expect(reasoningCallSetting(spec, 'off')).toBeUndefined();
    }
  });

  it('sends nothing to OpenAI behind an apiBase, whose Chat Completions adapter forwards it raw', () => {
    expect(
      reasoningCallSetting('openai/gpt-5', 'high', 'https://litellm.internal/v1')
    ).toBeUndefined();
    expect(reasoningCallSetting('openai/gpt-6-luna', 'off', 'https://gw/v1')).toBeUndefined();
    // Anthropic's adapter speaks the Messages API whatever the base.
    expect(reasoningCallSetting('anthropic/claude-opus-5-5', 'high', 'https://gw/v1')).toBe('high');
  });

  it('ignores an OpenAI-compatible provider and a malformed spec, never failing', () => {
    expect(reasoningCallSetting('openrouter/anthropic/claude-opus-5-5', 'high')).toBeUndefined();
    expect(reasoningCallSetting('ollama/llama-4', 'off')).toBeUndefined();
    expect(reasoningCallSetting('no-slash', 'high')).toBeUndefined();
  });
});

describe('claudeCodeEffort', () => {
  it('maps the levels onto effort and leaves off and no opinion to the harness', () => {
    expect(claudeCodeEffort('low')).toBe('low');
    expect(claudeCodeEffort('medium')).toBe('medium');
    expect(claudeCodeEffort('high')).toBe('high');
    expect(claudeCodeEffort('off')).toBeUndefined();
    expect(claudeCodeEffort(null)).toBeUndefined();
  });
});

function recordingModel() {
  const seen: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: { reasoning?: unknown }) => {
      seen.push(options.reasoning);
      return {
        content: [{ text: 'ok', type: 'text' }],
        finishReason: { raw: 'end_turn', unified: 'stop' },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      };
    },
  } as never);
  return { model, seen };
}

describe('reasoningMiddleware', () => {
  it('asks every call for the level, unless the caller set one', async () => {
    const { model, seen } = recordingModel();
    const wrapped = wrapLanguageModel({ middleware: reasoningMiddleware('medium'), model });
    await generateText({ model: wrapped, prompt: 'hi' });
    await generateText({ model: wrapped, prompt: 'hi', reasoning: 'low' });
    expect(seen).toEqual(['medium', 'low']);
  });
});

/** The JSON body a provider adapter sends for one call made with `reasoning`. */
async function requestBody(
  build: (fetch: typeof globalThis.fetch) => Parameters<typeof wrapLanguageModel>[0]['model'],
  reasoning: Parameters<typeof reasoningMiddleware>[0]
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    // A refusal is enough: the request has been built and captured.
    return new Response(JSON.stringify({ error: { message: 'stop', type: 'invalid_request' } }), {
      headers: { 'content-type': 'application/json' },
      status: 400,
    });
  }) as typeof globalThis.fetch;
  const model = wrapLanguageModel({
    middleware: reasoningMiddleware(reasoning),
    model: build(fetch),
  });
  await generateText({ maxRetries: 0, model, prompt: 'hi' }).catch(() => undefined);
  return body;
}

describe('the installed provider adapters', () => {
  it('Anthropic: adaptive thinking with an effort on a model that only thinks adaptively', async () => {
    const body = await requestBody(
      (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-5-5'),
      'high'
    );
    expect(body.thinking).toMatchObject({ type: 'adaptive' });
    expect(body.output_config).toMatchObject({ effort: 'high' });
  });

  it('Anthropic: a thinking budget, with room for it, on a model that predates adaptive thinking', async () => {
    const body = await requestBody(
      (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-haiku-4-5-20251001'),
      'medium'
    );
    const thinking = body.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBeGreaterThan(0);
    expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
  });

  it('OpenAI: a reasoning effort', async () => {
    const body = await requestBody(
      (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-6-astra'),
      'low'
    );
    expect(body.reasoning).toMatchObject({ effort: 'low' });
  });

  it('Google: a thinking configuration', async () => {
    const body = await requestBody(
      (fetch) => createGoogleGenerativeAI({ apiKey: 'k', fetch })('gemini-3.8-flash'),
      'high'
    );
    expect(
      (body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig
    ).toBeDefined();
  });
});
