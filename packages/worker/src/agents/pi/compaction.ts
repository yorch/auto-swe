import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';

/** Characters per token in the estimate: coarse, and the same for every provider. */
const CHARS_PER_TOKEN = 4;
/** What an image costs in the estimate, in characters; Pi's runtime reads files as text. */
const IMAGE_CHARS = 4_000;
/** The most recent assistant turns whose tool results are never elided. */
export const KEEP_RECENT_ASSISTANT_TURNS = 4;

type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

function roleOf(message: AgentMessage): string {
  return (message as { role: string }).role;
}

function partChars(part: Part): number {
  switch (part.type) {
    case 'text':
      return part.text?.length ?? 0;
    case 'thinking':
      return part.thinking?.length ?? 0;
    case 'toolCall':
      return (part.name?.length ?? 0) + JSON.stringify(part.arguments ?? {}).length;
    default:
      return IMAGE_CHARS;
  }
}

function messageChars(message: AgentMessage): number {
  const { content } = message as UserMessage | AssistantMessage | ToolResultMessage;
  if (typeof content === 'string') {
    return content.length;
  }
  return Array.isArray(content) ? (content as Part[]).reduce((n, p) => n + partChars(p), 0) : 0;
}

/**
 * A rough token count for what one model call sends: the system prompt plus
 * every message. Characters over four, which over- rather than under-counts
 * code and JSON; the provider's own tokenizer is not available, and an exact
 * count is not needed to stay clear of a context window.
 */
export function estimateTokens(systemPrompt: string, messages: readonly AgentMessage[]): number {
  const chars = messages.reduce((n, m) => n + messageChars(m), systemPrompt.length);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** What replaces a tool result's text once it is elided. */
export function elisionStub(toolName: string): string {
  return `[output of ${toolName} elided to save context; re-run the tool if you need it]`;
}

export interface CompactionResult {
  afterTokens: number;
  beforeTokens: number;
  /** Messages removed with the exchanges they belonged to. */
  droppedMessages: number;
  /** Tool results this compaction stubbed and that are still in the history. */
  elidedResults: number;
  /** The messages to send (the input array itself when nothing changed). */
  messages: AgentMessage[];
}

function isElided(message: ToolResultMessage): boolean {
  const first = message.content[0];
  return (
    message.content.length === 1 &&
    first?.type === 'text' &&
    first.text === elisionStub(message.toolName)
  );
}

/**
 * Fit a conversation to a token budget without a model call.
 *
 * In order, until the estimate is under `budgetTokens`:
 * 1. Replace the text of tool results older than the most recent
 *    {@link KEEP_RECENT_ASSISTANT_TURNS} assistant turns with a stub, oldest
 *    first. The result keeps its `toolCallId`, `toolName` and `isError`, so every
 *    tool call still has its result and the conversation stays well formed for
 *    every provider.
 * 2. Drop the oldest whole exchanges: a user message and everything up to the
 *    next user message, so a tool call and its result are always dropped
 *    together and the history still begins with a user message.
 *
 * The newest exchange, which holds the current prompt, is never dropped; if it
 * alone exceeds the budget it is returned as it is and the provider decides.
 * The input is not modified.
 */
export function compactMessages(input: {
  budgetTokens: number;
  messages: readonly AgentMessage[];
  systemPrompt: string;
  keepRecentAssistantTurns?: number;
}): CompactionResult {
  const { budgetTokens, systemPrompt } = input;
  const keep = input.keepRecentAssistantTurns ?? KEEP_RECENT_ASSISTANT_TURNS;
  const original = input.messages as AgentMessage[];
  const beforeTokens = estimateTokens(systemPrompt, original);
  const unchanged: CompactionResult = {
    afterTokens: beforeTokens,
    beforeTokens,
    droppedMessages: 0,
    elidedResults: 0,
    messages: original,
  };
  if (beforeTokens <= budgetTokens) {
    return unchanged;
  }

  let messages = [...original];
  let tokens = beforeTokens;
  const elided: number[] = [];

  // 1. Elide old tool output, oldest first. Results at or after the `keep`-th
  // most recent assistant message are left alone.
  const assistants = messages.flatMap((m, i) => (roleOf(m) === 'assistant' ? [i] : []));
  const recentStart = assistants.length >= keep && keep > 0 ? (assistants.at(-keep) ?? 0) : 0;
  const elidable = keep > 0 ? recentStart : messages.length;
  for (let i = 0; i < elidable && tokens > budgetTokens; i++) {
    const m = messages[i] as AgentMessage;
    if (roleOf(m) !== 'toolResult') {
      continue;
    }
    const result = m as ToolResultMessage;
    const stub = elisionStub(result.toolName);
    if (isElided(result) || messageChars(result) <= stub.length) {
      continue;
    }
    // `details` is the tool's own structured output and can be as large as the text.
    const { details: _details, ...rest } = result;
    messages[i] = { ...rest, content: [{ text: stub, type: 'text' }] } as ToolResultMessage;
    tokens = estimateTokens(systemPrompt, messages);
    elided.push(i);
  }

  // 2. Drop the oldest whole exchanges, never the newest.
  let firstKept = 0;
  if (tokens > budgetTokens) {
    const starts = messages.flatMap((m, i) => (roleOf(m) === 'user' ? [i] : []));
    for (let n = 1; n < starts.length && tokens > budgetTokens; n++) {
      firstKept = starts[n] as number;
      tokens = estimateTokens(systemPrompt, messages.slice(firstKept));
    }
    messages = messages.slice(firstKept);
  }

  const elidedResults = elided.filter((i) => i >= firstKept).length;
  if (elidedResults === 0 && firstKept === 0) {
    return unchanged;
  }
  return {
    afterTokens: estimateTokens(systemPrompt, messages),
    beforeTokens,
    droppedMessages: firstKept,
    elidedResults,
    messages,
  };
}
