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
  /**
   * The record this was built from: a real API exchange (`http_call`), one
   * SDK stream message, or a reconstruction from the harness's session file —
   * which carries neither the system prompt nor the tool schemas.
   */
  source?: 'http_call' | 'harness_message' | 'harness_session_file';
  model?: string;
  system?: string;
  messages: NormalizedMessage[];
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  response: {
    content: NormalizedPart[];
    finishReason?: string;
    /**
     * The provider's own figures. Whether `inputTokens` already contains the cached part depends
     * on the provider: Anthropic reports it WITHOUT `cacheRead`/`cacheWrite`; OpenAI (chat and
     * responses) and Google report a total that includes `cacheRead`. Adding the two is right for
     * one and double-counts for the others.
     */
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}
