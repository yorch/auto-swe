import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from '@mariozechner/pi-ai';
import type {
  ContentPart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  ToolSet,
} from 'ai';
import type { UsageTotals } from '../harness/usage.js';

/**
 * Pi's loop names the model it calls with a pi-ai `Model`. Every call here goes
 * through {@link aiSdkStreamFn} instead, which ignores everything but the id, so
 * this descriptor only has to say who the model is.
 */
export function piModelDescriptor(spec: string): Model<string> {
  const slash = spec.indexOf('/');
  return {
    api: 'auto-swe',
    baseUrl: '',
    contextWindow: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: spec.slice(slash + 1),
    input: ['text'],
    maxTokens: 0,
    name: spec,
    provider: spec.slice(0, slash),
    reasoning: false,
  };
}

/**
 * One model call's counters from the AI SDK's usage, cache traffic apart from
 * fresh input. `outputTokens` is the whole output, reasoning included (its
 * `outputTokenDetails` split text from reasoning), so a call that thinks is
 * metered and priced for its thinking.
 */
export function usageTotals(usage: LanguageModelUsage | undefined): UsageTotals {
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const input =
    usage?.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage?.inputTokens ?? 0) - cacheRead - cacheWrite);
  return { cacheRead, cacheWrite, input, output: usage?.outputTokens ?? 0 };
}

function piUsage(totals: UsageTotals): Usage {
  return {
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: totals.input,
    output: totals.output,
    totalTokens: totals.input + totals.cacheRead + totals.cacheWrite + totals.output,
  };
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string'
    ? content
    : content
        .map((part) =>
          part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? '[image omitted]' : ''
        )
        .join('');
}

/**
 * Pi keeps an assistant part's provider metadata — Anthropic's thinking
 * signature or redacted data, OpenAI's reasoning item and encrypted content,
 * Google's thought signature — in the part's own signature field, as JSON under
 * this prefix. Every model call goes through {@link aiSdkStreamFn}, so nothing
 * else writes or reads those fields.
 */
const METADATA_PREFIX = 'aisdk:';

function encodeMetadata(metadata: ProviderMetadata | undefined): string | undefined {
  return metadata && Object.keys(metadata).length > 0
    ? `${METADATA_PREFIX}${JSON.stringify(metadata)}`
    : undefined;
}

function decodeMetadata(signature: string | undefined): ProviderMetadata | undefined {
  if (!signature?.startsWith(METADATA_PREFIX)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(signature.slice(METADATA_PREFIX.length));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ProviderMetadata)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `providerOptions` for a part, only when it has any. */
function withOptions(signature: string | undefined): { providerOptions?: ProviderMetadata } {
  const providerOptions = decodeMetadata(signature);
  return providerOptions ? { providerOptions } : {};
}

/**
 * Pi's conversation as AI SDK messages. An assistant turn keeps its parts in
 * the order the model produced them, and each part its provider metadata, so a
 * reasoning part goes back with its signature: with thinking on, a provider
 * reads the previous turn's thinking when the model continues after a tool
 * call. Images are dropped: no tool here produces one.
 */
export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ content: textOf(message.content), role: 'user' });
    } else if (message.role === 'assistant') {
      const content: Extract<ModelMessage, { role: 'assistant' }>['content'] = [];
      for (const part of message.content) {
        if (part.type === 'text' && part.text.length > 0) {
          content.push({ text: part.text, type: 'text', ...withOptions(part.textSignature) });
        } else if (part.type === 'thinking') {
          content.push({
            text: part.thinking,
            type: 'reasoning',
            ...withOptions(part.thinkingSignature),
          });
        } else if (part.type === 'toolCall') {
          content.push({
            input: part.arguments,
            toolCallId: part.id,
            toolName: part.name,
            type: 'tool-call',
            ...withOptions(part.thoughtSignature),
          });
        }
      }
      if (content.length > 0) {
        out.push({ content, role: 'assistant' });
      }
    } else {
      const value = textOf(message.content);
      out.push({
        content: [
          {
            output: message.isError ? { type: 'error-text', value } : { type: 'text', value },
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            type: 'tool-result',
          },
        ],
        role: 'tool',
      });
    }
  }
  return out;
}

/**
 * A model call's output as Pi's assistant content, in the order the model
 * produced it, each part's provider metadata kept in its signature field for
 * {@link toModelMessages} to send back.
 */
export function piContentOf(parts: readonly ContentPart<ToolSet>[]): AssistantMessage['content'] {
  const content: AssistantMessage['content'] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) {
      const textSignature = encodeMetadata(part.providerMetadata);
      content.push({ text: part.text, type: 'text', ...(textSignature ? { textSignature } : {}) });
    } else if (part.type === 'reasoning') {
      const thinkingSignature = encodeMetadata(part.providerMetadata);
      const redacted = part.providerMetadata?.anthropic?.redactedData != null;
      content.push({
        thinking: part.text,
        type: 'thinking',
        ...(thinkingSignature ? { thinkingSignature } : {}),
        ...(redacted ? { redacted } : {}),
      });
    } else if (part.type === 'tool-call') {
      const thoughtSignature = encodeMetadata(part.providerMetadata);
      content.push({
        arguments: (part.input && typeof part.input === 'object'
          ? part.input
          : {}) as ToolCall['arguments'],
        id: part.toolCallId,
        name: part.toolName,
        type: 'toolCall',
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
    }
  }
  return content;
}

function stopReasonOf(finishReason: string): StopReason {
  switch (finishReason) {
    case 'tool-calls':
      return 'toolUse';
    case 'length':
      return 'length';
    default:
      return 'stop';
  }
}

export interface AiSdkStreamOptions {
  /** The Agent's model, bound by the worker's own `resolveModel` (guarded fetch, provider rules). */
  model: LanguageModel;
  /** The Agent's `<provider>/<model>` spec, as the message names its model. */
  spec: string;
  /** Called with each model call's usage once the call is complete. */
  onCall: (call: { id: string; usage: UsageTotals }) => void;
  /** Keeps the activity alive while a call is in flight. */
  heartbeat: () => void;
  /**
   * Called with the error a failed call threw. Pi's loop keeps only its
   * message, so the turn rethrows this one: its type is what the retry policy
   * reads.
   */
  onError: (err: unknown) => void;
}

/**
 * Pi's model call, made by the worker's AI SDK model rather than pi-ai's own
 * provider clients. The model carries the Agent's reasoning level
 * (`lib/models.ts`), so a call here thinks as a Mastra call would. pi-ai builds a provider client per call and gives it the
 * process's global `fetch`, so it would bypass the SSRF guard every other model
 * call goes through (`lib/models.ts`) and the private-network allowlist with it.
 *
 * One call is one `generateText` step with the tools declared and none
 * executed: the model's tool calls come back to Pi's loop, which decides and
 * runs them. The loop reads only the finished message, so the stream carries
 * just that, as one `done` (or `error`) event.
 */
export function aiSdkStreamFn(options: AiSdkStreamOptions, tools: () => AgentTool[]): StreamFn {
  return async (_model, context: Context, callOptions) => {
    const { createAssistantMessageEventStream } = await import('@mariozechner/pi-ai');
    const { generateText, jsonSchema, tool } = await import('ai');
    const stream = createAssistantMessageEventStream();
    const descriptor = piModelDescriptor(options.spec);
    const message = (fields: Partial<AssistantMessage>): AssistantMessage => ({
      api: descriptor.api,
      content: [],
      model: descriptor.id,
      provider: descriptor.provider,
      role: 'assistant',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: piUsage({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }),
      ...fields,
    });

    const toolSet: ToolSet = {};
    for (const t of tools()) {
      toolSet[t.name] = tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
      });
    }

    const pulse = setInterval(() => {
      try {
        options.heartbeat();
      } catch {
        /* not in an activity context */
      }
    }, 10_000);
    pulse.unref?.();
    try {
      const result = await generateText({
        abortSignal: callOptions?.signal,
        messages: toModelMessages(context.messages),
        model: options.model,
        system: context.systemPrompt,
        ...(Object.keys(toolSet).length > 0 ? { toolChoice: 'auto' as const, tools: toolSet } : {}),
      });
      const usage = usageTotals(result.usage);
      const id = result.response?.id ?? `call-${Date.now()}`;
      options.onCall({ id, usage });
      const content = piContentOf(result.content);
      const stopReason = stopReasonOf(result.finishReason);
      stream.push({
        message: message({ content, responseId: id, stopReason, usage: piUsage(usage) }),
        reason: stopReason === 'toolUse' || stopReason === 'length' ? stopReason : 'stop',
        type: 'done',
      });
    } catch (err) {
      const aborted = callOptions?.signal?.aborted ?? false;
      if (!aborted) {
        options.onError(err);
      }
      stream.push({
        error: message({
          errorMessage: err instanceof Error ? err.message : String(err),
          stopReason: aborted ? 'aborted' : 'error',
        }),
        reason: aborted ? 'aborted' : 'error',
        type: 'error',
      });
    } finally {
      clearInterval(pulse);
    }
    return stream;
  };
}
