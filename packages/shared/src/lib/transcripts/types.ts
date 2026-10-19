/**
 * Provider-agnostic shape one recorded model call is normalized into. The
 * gateway's `format=normalized` transcript reads map each `http_call` (and
 * Claude Code `harness_message`) record through `normalizeTranscriptRecord`.
 */

export type NormalizedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { type: 'image' | 'file'; reference: string };

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: NormalizedPart[];
}

export interface NormalizedCall {
  provider: 'anthropic' | 'openai-responses' | 'openai-chat' | 'google' | 'claude-code';
  model?: string;
  system?: string;
  messages: NormalizedMessage[];
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  response: {
    content: NormalizedPart[];
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}
