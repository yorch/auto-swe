import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';

/**
 * Characters per token in the estimate. Code, JSON and paths tokenise at about
 * three characters a token or fewer, so four would under-count exactly the
 * content a coding session is made of; three errs towards compacting early.
 */
const CHARS_PER_TOKEN = 3;
/** What an image costs in the estimate, in characters; Pi's runtime reads files as text. */
const IMAGE_CHARS = 4_000;
/** The most recent assistant turns whose output is spared while anything older can go. */
export const KEEP_RECENT_ASSISTANT_TURNS = 4;
/** A tool-call argument string at or under this many characters is not worth stubbing. */
const MIN_ELIDABLE_ARG_CHARS = 200;
/** The tools whose call arguments carry file content, and the fields that do. */
const CONTENT_TOOLS = new Set(['write', 'edit']);

type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type Role = 'user' | 'assistant' | 'toolResult';

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

/** The size of the tool definitions a call also sends: name, description and parameter schema. */
export function toolDefinitionChars(
  tools: readonly { name: string; description: string; parameters?: unknown }[]
): number {
  return tools.reduce(
    (n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters ?? {}).length,
    0
  );
}

/**
 * A rough token count for what one model call sends: the system prompt, the
 * tool definitions (`overheadChars`) and every message. Characters over three;
 * the provider's own tokenizer is not available, and an exact count is not
 * needed to stay clear of a context window.
 */
export function estimateTokens(
  systemPrompt: string,
  messages: readonly AgentMessage[],
  overheadChars = 0
): number {
  const chars = messages.reduce((n, m) => n + messageChars(m), systemPrompt.length + overheadChars);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** What replaces a tool result's text once it is elided. */
export function elisionStub(toolName: string): string {
  return `[output of ${toolName} elided to save context; re-run the tool if you need it]`;
}

const argStub = (chars: number) => `[${chars} chars elided]`;
const ARG_STUB_RE = /^\[\d+ chars elided\]$/;

export interface CompactionResult {
  afterTokens: number;
  beforeTokens: number;
  /** Messages removed with the exchanges they belonged to. */
  droppedMessages: number;
  /** Assistant messages whose `write`/`edit` arguments this compaction stubbed and that remain. */
  elidedArguments: number;
  /** Tool results this compaction stubbed and that remain. */
  elidedResults: number;
  /** The messages to send (the input array itself when nothing changed). */
  messages: AgentMessage[];
}

function isElidedResult(message: ToolResultMessage): boolean {
  const first = message.content[0];
  return (
    message.content.length === 1 &&
    first?.type === 'text' &&
    first.text === elisionStub(message.toolName)
  );
}

/** Stub one large string; reports whether it did. */
function stubString(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > MIN_ELIDABLE_ARG_CHARS &&
    !ARG_STUB_RE.test(value)
    ? argStub(value.length)
    : undefined;
}

/** A `write`/`edit` call's arguments with their large strings stubbed, or null if none is. */
function shrunkArguments(args: Record<string, unknown>): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...args };
  let changed = false;
  for (const key of ['content', 'oldText', 'newText']) {
    const stub = stubString(args[key]);
    if (stub) {
      next[key] = stub;
      changed = true;
    }
  }
  if (Array.isArray(args.edits)) {
    next.edits = args.edits.map((edit) => {
      if (typeof edit !== 'object' || edit === null) {
        return edit;
      }
      const copy: Record<string, unknown> = { ...(edit as Record<string, unknown>) };
      for (const key of ['oldText', 'newText']) {
        const stub = stubString(copy[key]);
        if (stub) {
          copy[key] = stub;
          changed = true;
        }
      }
      return copy;
    });
  }
  return changed ? next : null;
}

/** The message with its bulk replaced by stubs, or null when there is nothing to save. */
function shrunk(message: AgentMessage): AgentMessage | null {
  const role = roleOf(message) as Role;
  if (role === 'toolResult') {
    const result = message as ToolResultMessage;
    const stub = elisionStub(result.toolName);
    if (isElidedResult(result) || messageChars(result) <= stub.length) {
      return null;
    }
    // `details` is the tool's own structured output and can be as large as the text.
    const { details: _details, ...rest } = result;
    return { ...rest, content: [{ text: stub, type: 'text' }] } as ToolResultMessage;
  }
  if (role === 'assistant') {
    const assistant = message as AssistantMessage;
    let changed = false;
    const content = assistant.content.map((part) => {
      if (part.type !== 'toolCall' || !CONTENT_TOOLS.has(part.name)) {
        return part;
      }
      const args = shrunkArguments(part.arguments as Record<string, unknown>);
      if (!args) {
        return part;
      }
      changed = true;
      return { ...part, arguments: args };
    });
    return changed ? ({ ...assistant, content } as AssistantMessage) : null;
  }
  return null;
}

/**
 * Fit a conversation to a token budget without a model call.
 *
 * In order, until the estimate is under `budgetTokens`:
 * 1. Stub the bulk of every exchange before the newest: tool results, and the
 *    file content in `write`/`edit` call arguments (`content`, `oldText`,
 *    `newText`, `edits[]`), oldest first. A result keeps its `toolCallId`,
 *    `toolName` and `isError`, and a call keeps its `id`, `name` and `path`, so
 *    every tool call still has its result and the conversation stays well
 *    formed for every provider.
 * 2. Drop the oldest whole exchanges: a user message and everything up to the
 *    next user message, so a tool call and its result are always dropped
 *    together and the history still begins with a user message.
 * 3. Only then stub inside the newest exchange, oldest first: first sparing the
 *    most recent {@link KEEP_RECENT_ASSISTANT_TURNS} assistant turns, then
 *    everything but the last tool call and its result, then those too.
 *
 * The newest exchange, which holds the current prompt, is never dropped; if it
 * alone exceeds the budget after phase 3 it is returned as it is and the
 * provider decides. The input is not modified: the messages may be the agent
 * loop's live array.
 */
export function compactMessages(input: {
  budgetTokens: number;
  messages: readonly AgentMessage[];
  systemPrompt: string;
  /** Characters sent beside the messages and system prompt: the tool definitions. */
  overheadChars?: number;
  keepRecentAssistantTurns?: number;
}): CompactionResult {
  const { budgetTokens, systemPrompt } = input;
  const keep = input.keepRecentAssistantTurns ?? KEEP_RECENT_ASSISTANT_TURNS;
  const original = input.messages as AgentMessage[];
  const fixedChars = systemPrompt.length + (input.overheadChars ?? 0);
  const beforeTokens = estimateTokens(systemPrompt, original, input.overheadChars);
  const unchanged: CompactionResult = {
    afterTokens: beforeTokens,
    beforeTokens,
    droppedMessages: 0,
    elidedArguments: 0,
    elidedResults: 0,
    messages: original,
  };
  if (beforeTokens <= budgetTokens) {
    return unchanged;
  }

  const messages = [...original];
  const sizes = messages.map(messageChars);
  let chars = fixedChars + sizes.reduce((n, c) => n + c, 0);
  const over = () => Math.ceil(chars / CHARS_PER_TOKEN) > budgetTokens;
  const shrunkResults = new Set<number>();
  const shrunkCalls = new Set<number>();

  /** Stub messages in [lo, hi) oldest first until under budget. */
  const pass = (lo: number, hi: number) => {
    for (let i = lo; i < hi && over(); i++) {
      const next = shrunk(messages[i] as AgentMessage);
      if (!next) {
        continue;
      }
      messages[i] = next;
      const size = messageChars(next);
      chars -= (sizes[i] as number) - size;
      sizes[i] = size;
      (roleOf(next) === 'toolResult' ? shrunkResults : shrunkCalls).add(i);
    }
  };

  const userStarts = messages.flatMap((m, i) => (roleOf(m) === 'user' ? [i] : []));
  const newestStart = userStarts.at(-1) ?? 0;

  // 1. Older exchanges.
  pass(0, newestStart);

  // 2. Drop the oldest whole exchanges, never the newest.
  let firstKept = 0;
  for (let n = 1; n < userStarts.length && over(); n++) {
    const next = userStarts[n] as number;
    if (next > newestStart) {
      break;
    }
    for (let i = firstKept; i < next; i++) {
      chars -= sizes[i] as number;
    }
    firstKept = next;
  }

  // 3. The newest exchange, sparing its latest work for as long as possible.
  if (over()) {
    const assistants = messages.flatMap((m, i) =>
      i >= firstKept && roleOf(m) === 'assistant' ? [i] : []
    );
    const spared =
      keep > 0 && assistants.length >= keep ? (assistants.at(-keep) as number) : firstKept;
    const callers = assistants.filter((i) =>
      (messages[i] as AssistantMessage).content.some((p) => p.type === 'toolCall')
    );
    const lastCalling = callers.at(-1);
    pass(firstKept, spared);
    pass(firstKept, lastCalling ?? messages.length);
    pass(firstKept, messages.length);
  }

  const elidedResults = [...shrunkResults].filter((i) => i >= firstKept).length;
  const elidedArguments = [...shrunkCalls].filter((i) => i >= firstKept).length;
  if (elidedResults === 0 && elidedArguments === 0 && firstKept === 0) {
    return unchanged;
  }
  return {
    afterTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    beforeTokens,
    droppedMessages: firstKept,
    elidedArguments,
    elidedResults,
    messages: messages.slice(firstKept),
  };
}
