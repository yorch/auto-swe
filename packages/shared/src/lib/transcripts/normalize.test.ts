import { describe, expect, it } from 'vitest';
import {
  anthropicJson,
  anthropicSse,
  googleJson,
  googleSse,
  harnessAssistant,
  openaiChatJson,
  openaiChatSse,
  openaiResponsesJson,
  openaiResponsesSse,
} from './__fixtures__/records.js';
import { normalizeTranscriptRecord } from './normalize.js';
import { scrubPii } from './piiScrub.js';

describe('normalizeTranscriptRecord', () => {
  it('normalizes a non-streamed Anthropic Messages call', () => {
    const n = normalizeTranscriptRecord(anthropicJson);
    expect(n).toMatchObject({
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      system: 'You are an implementer.',
    });
    expect(n?.messages[0]?.role).toBe('user');
    expect(n?.messages[1]?.content[0]).toMatchObject({ id: 'toolu_1', type: 'tool_result' });
    expect(n?.tools?.[0]?.name).toBe('bash');
    expect(n?.response.content).toEqual([
      { text: 'Running the test.', type: 'text' },
      { id: 'toolu_2', input: { command: 'yarn test' }, name: 'bash', type: 'tool_call' },
    ]);
    expect(n?.response.finishReason).toBe('tool_use');
    expect(n?.response.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });

  it('reassembles a streamed Anthropic call, thinking and input_json_delta included', () => {
    const n = normalizeTranscriptRecord(anthropicSse);
    expect(n?.provider).toBe('anthropic');
    expect(n?.response.content).toEqual([
      { text: 'let me see', type: 'reasoning' },
      { id: 'toolu_9', input: { command: 'yarn test' }, name: 'bash', type: 'tool_call' },
    ]);
    expect(n?.response.finishReason).toBe('tool_use');
    expect(n?.response.usage).toMatchObject({
      cacheRead: 40,
      cacheWrite: 5,
      inputTokens: 120,
      outputTokens: 42,
    });
  });

  it('normalizes a non-streamed OpenAI Responses call', () => {
    const n = normalizeTranscriptRecord(openaiResponsesJson);
    expect(n).toMatchObject({
      model: 'gpt-5.5',
      provider: 'openai-responses',
      system: 'Be concise.',
    });
    expect(n?.messages[1]?.content[0]).toMatchObject({ id: 'call_1', type: 'tool_result' });
    expect(n?.response.content).toEqual([
      { text: 'The diff renames two functions.', type: 'text' },
      { id: 'call_2', input: {}, name: 'run_tests', type: 'tool_call' },
    ]);
    expect(n?.response.usage).toMatchObject({
      cacheRead: 50,
      inputTokens: 200,
      outputTokens: 40,
    });
  });

  it('reads the terminal event of a streamed OpenAI Responses call', () => {
    const n = normalizeTranscriptRecord(openaiResponsesSse);
    expect(n?.response.content).toContainEqual({
      id: 'call_2',
      input: {},
      name: 'run_tests',
      type: 'tool_call',
    });
  });

  it('normalizes a non-streamed OpenAI chat completions call', () => {
    const n = normalizeTranscriptRecord(openaiChatJson);
    expect(n?.provider).toBe('openai-chat');
    expect(n?.system).toBe('You are a reviewer.');
    expect(n?.response.content[0]).toEqual({
      id: 'call_1',
      input: { body: 'looks good' },
      name: 'comment',
      type: 'tool_call',
    });
    expect(n?.response.usage).toMatchObject({ inputTokens: 80, outputTokens: 12 });
  });

  it('reassembles a streamed OpenAI chat completions call', () => {
    const n = normalizeTranscriptRecord(openaiChatSse);
    expect(n?.response.content).toEqual([{ text: 'Looks good', type: 'text' }]);
    expect(n?.response.finishReason).toBe('stop');
    expect(n?.model).toBe('litellm-gpt');
  });

  it('normalizes a non-streamed Google generateContent call', () => {
    const n = normalizeTranscriptRecord(googleJson);
    expect(n?.provider).toBe('google');
    expect(n?.system).toBe('You explore code.');
    expect(n?.messages[1]?.content[0]).toMatchObject({ id: 'read_file', type: 'tool_result' });
    expect(n?.response.content[0]).toEqual({
      id: 'read_file',
      input: { path: 'README.md' },
      name: 'read_file',
      type: 'tool_call',
    });
    expect(n?.response.usage).toMatchObject({ inputTokens: 300, outputTokens: 20 });
    expect(n?.tools?.[0]?.name).toBe('read_file');
  });

  it('normalizes a streamed Google streamGenerateContent call', () => {
    const n = normalizeTranscriptRecord(googleSse);
    expect(n?.provider).toBe('google');
    expect(n?.response.content).toEqual([{ text: 'Done.', type: 'text' }]);
    expect(n?.response.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it('maps a Claude Code harness_message to a call', () => {
    const n = normalizeTranscriptRecord(harnessAssistant);
    expect(n?.provider).toBe('claude-code');
    expect(n?.model).toBe('claude-opus-5-5');
    expect(n?.messages[0]?.content).toEqual([
      { text: 'Checking the tests.', type: 'text' },
      { id: 'toolu_1', input: { command: 'yarn test' }, name: 'Bash', type: 'tool_call' },
    ]);
  });

  it('returns null for an unknown record shape', () => {
    expect(
      normalizeTranscriptRecord({
        kind: 'http_call',
        path: '/v1/unknown',
        request: {},
        response: { body: {} },
      })
    ).toBeNull();
    expect(normalizeTranscriptRecord({ kind: 'marker' })).toBeNull();
    expect(
      normalizeTranscriptRecord({
        kind: 'http_call',
        path: '/v1/messages',
        request: 'x',
        response: { body: '' },
      })
    ).toBeNull();
  });
});

describe('scrubPii', () => {
  it('replaces emails, phones, IPs and Luhn-valid card numbers', () => {
    const scrubbed = scrubPii({
      card: '4111 1111 1111 1111',
      contact: 'reach me at jane.doe@example.com or +1 (415) 555-2671',
      host: 'came from 203.0.113.7 or 2001:db8::ff00:42:8329',
      nonCard: '1234 5678 9012 3456',
      untouched: 42,
    }) as Record<string, unknown>;
    expect(scrubbed.card).toBe('[CARD]');
    expect(scrubbed.nonCard).toBe('1234 5678 9012 3456');
    expect(scrubbed.contact).toBe('reach me at [EMAIL] or [PHONE]');
    expect(scrubbed.host).toBe('came from [IP] or [IP]');
    expect(scrubbed.untouched).toBe(42);
  });

  it('scrubs strings nested inside arrays and objects', () => {
    const scrubbed = scrubPii({ list: ['mail a@b.co', { deep: 'a@b.co' }] }) as {
      list: unknown[];
    };
    expect(scrubbed.list).toEqual(['mail [EMAIL]', { deep: '[EMAIL]' }]);
  });
});
