/**
 * Map one transcript record (`http_call` request/response bodies, or a Claude
 * Code `harness_message`) to a provider-agnostic {@link NormalizedCall}.
 *
 * Detection is by path: Anthropic `/v1/messages`, OpenAI Responses
 * `/responses`, OpenAI-compatible `/chat/completions`, Google
 * `:generateContent` / `:streamGenerateContent`. Both JSON and SSE responses
 * are reassembled (Anthropic thinking + `input_json_delta` included). An
 * unknown shape returns `null`; the caller emits the raw record instead.
 */
import { parseSseEvents } from './sse.js';
import type { NormalizedCall, NormalizedMessage, NormalizedPart } from './types.js';

export type { NormalizedCall, NormalizedMessage, NormalizedPart } from './types.js';

interface HttpCallLike {
  path?: string;
  request?: unknown;
  response?: { contentType?: string | null; body?: unknown };
}

interface RecordLike {
  kind?: string;
  path?: string;
  request?: unknown;
  response?: { contentType?: string | null; body?: unknown };
  message?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Response body as parsed events: JSON object or SSE event list. */
function responseEvents(record: HttpCallLike): unknown[] {
  const body = record.response?.body;
  if (isObj(body)) {
    return [body];
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    return parseSseEvents(body);
  }
  return [];
}

/** The final response event for providers that stream cumulative snapshots. */
function lastOfType(events: unknown[], types: string[]): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isObj(e) && types.includes(String(e.type ?? e.event ?? ''))) {
      return e;
    }
  }
  return undefined;
}

// ── Anthropic Messages ──────────────────────────────────────────────────────

function anthropicContentPart(block: unknown): NormalizedPart | null {
  if (!isObj(block)) {
    return null;
  }
  switch (block.type) {
    case 'text':
      return { text: asString(block.text) ?? '', type: 'text' };
    case 'thinking':
      return { text: asString(block.thinking) ?? '', type: 'reasoning' };
    case 'tool_use':
      return {
        id: asString(block.id) ?? '',
        input: block.input,
        name: asString(block.name) ?? '',
        type: 'tool_call',
      };
    case 'tool_result':
      return {
        id: asString(block.tool_use_id) ?? '',
        isError: block.is_error === true ? true : undefined,
        output: block.content,
        type: 'tool_result',
      };
    case 'image':
      return {
        reference: asString((block.source as Record<string, unknown> | undefined)?.url) ?? 'image',
        type: 'image',
      };
    default:
      return null;
  }
}

function anthropicMessage(role: string, content: unknown): NormalizedMessage {
  return {
    content: asArray(content)
      .map(anthropicContentPart)
      .filter((p): p is NormalizedPart => p !== null),
    role: (role as NormalizedMessage['role']) ?? 'user',
  };
}

/**
 * Reassemble a streamed Anthropic Messages response: content blocks built up
 * by `content_block_start` / `content_block_delta` (including thinking and
 * `input_json_delta`), usage from `message_start`/`message_delta`.
 */
function anthropicFromStream(events: unknown[]): NormalizedCall['response'] | null {
  const start = lastOfType(events, ['message_start']);
  const stop = lastOfType(events, ['message_stop']);
  const delta = lastOfType(events, ['message_delta']);
  if (!start && !stop) {
    return null;
  }
  interface Block {
    type: string;
    name?: string;
    id?: string;
    text: string;
    json: string;
  }
  const blocks: Block[] = [];
  for (const e of events) {
    if (!isObj(e)) {
      continue;
    }
    if (e.type === 'content_block_start' && isObj(e.content_block)) {
      const b = e.content_block;
      blocks.push({
        id: asString(b.id),
        json: '',
        name: asString(b.name),
        text: asString(b.text) ?? asString(b.thinking) ?? '',
        type: String(b.type ?? 'text'),
      });
    } else if (e.type === 'content_block_delta' && isObj(e.delta)) {
      const i = asNumber(e.index) ?? blocks.length - 1;
      const b = blocks[i];
      if (!b) {
        continue;
      }
      if (e.delta.type === 'input_json_delta') {
        b.json += asString(e.delta.partial_json) ?? '';
      } else {
        b.text += asString(e.delta.text) ?? asString(e.delta.thinking) ?? '';
      }
    }
  }
  const content: NormalizedPart[] = blocks.map((b) => {
    if (b.type === 'tool_use') {
      let input: unknown = b.json;
      try {
        input = JSON.parse(b.json || '{}');
      } catch {
        // keep the raw string
      }
      return { id: b.id ?? '', input, name: b.name ?? '', type: 'tool_call' };
    }
    if (b.type === 'thinking') {
      return { text: b.text, type: 'reasoning' };
    }
    return { text: b.text, type: 'text' };
  });
  const startUsage = (start?.message as Record<string, unknown> | undefined)?.usage as
    | Record<string, unknown>
    | undefined;
  const deltaUsage = (delta?.usage ?? delta?.message) as Record<string, unknown> | undefined;
  return {
    content,
    finishReason:
      asString((delta?.delta as Record<string, unknown> | undefined)?.stop_reason) ??
      (stop ? 'stop' : undefined),
    usage: {
      cacheRead:
        asNumber(startUsage?.cache_read_input_tokens) ??
        asNumber(deltaUsage?.cache_read_input_tokens),
      cacheWrite:
        asNumber(startUsage?.cache_creation_input_tokens) ??
        asNumber(deltaUsage?.cache_creation_input_tokens),
      inputTokens: asNumber(startUsage?.input_tokens),
      outputTokens: asNumber(deltaUsage?.output_tokens) ?? asNumber(startUsage?.output_tokens),
    },
  };
}

function normalizeAnthropic(record: HttpCallLike): NormalizedCall | null {
  const req = isObj(record.request) ? record.request : null;
  if (!req) {
    return null;
  }
  const events = responseEvents(record);
  let response: NormalizedCall['response'] | null = null;
  let model = asString(req.model);
  if (events.length === 1 && isObj(events[0]) && events[0].type === 'message') {
    const m = events[0];
    const usage = m.usage as Record<string, unknown> | undefined;
    model = asString(m.model) ?? model;
    response = {
      content: asArray(m.content)
        .map(anthropicContentPart)
        .filter((p): p is NormalizedPart => p !== null),
      finishReason: asString(m.stop_reason),
      usage: {
        cacheRead: asNumber(usage?.cache_read_input_tokens),
        cacheWrite: asNumber(usage?.cache_creation_input_tokens),
        inputTokens: asNumber(usage?.input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
      },
    };
  } else {
    response = anthropicFromStream(events);
  }
  if (!response) {
    return null;
  }
  const system = req.system;
  return {
    messages: asArray(req.messages).map((m) => {
      const msg = isObj(m) ? m : {};
      // A bare string is one user text part; a content array maps part-by-part.
      const content = Array.isArray(msg.content)
        ? msg.content
        : msg.content !== undefined
          ? [{ text: msg.content, type: 'text' }]
          : [];
      return anthropicMessage(String(msg.role ?? 'user'), content);
    }),
    model,
    provider: 'anthropic',
    response,
    system: Array.isArray(system) ? jsonText(system) : asString(system),
    tools: asArray(req.tools).map((t) => {
      const tool = isObj(t) ? t : {};
      return {
        description: asString(tool.description),
        inputSchema: tool.input_schema,
        name: asString(tool.name) ?? '',
      };
    }),
  };
}

// ── OpenAI chat completions ─────────────────────────────────────────────────

function openaiContentParts(content: unknown): NormalizedPart[] {
  if (typeof content === 'string') {
    return [{ text: content, type: 'text' }];
  }
  return asArray(content)
    .map((part) => {
      if (!isObj(part)) {
        return null;
      }
      if (part.type === 'text') {
        return { text: asString(part.text) ?? '', type: 'text' } as NormalizedPart;
      }
      if (part.type === 'image_url') {
        return {
          reference:
            asString((part.image_url as Record<string, unknown> | undefined)?.url) ?? 'image',
          type: 'image',
        } as NormalizedPart;
      }
      return null;
    })
    .filter((p): p is NormalizedPart => p !== null);
}

function openaiToolCalls(calls: unknown): NormalizedPart[] {
  return asArray(calls)
    .map((c) => {
      if (!isObj(c) || !isObj(c.function)) {
        return null;
      }
      let input: unknown = c.function.arguments;
      try {
        input = JSON.parse(asString(c.function.arguments) ?? '{}');
      } catch {
        // keep raw arguments
      }
      return {
        id: asString(c.id) ?? '',
        input,
        name: asString(c.function.name) ?? '',
        type: 'tool_call',
      } as NormalizedPart;
    })
    .filter((p): p is NormalizedPart => p !== null);
}

function openaiMessage(m: unknown): NormalizedMessage | null {
  if (!isObj(m)) {
    return null;
  }
  const role = String(m.role ?? 'user') as NormalizedMessage['role'];
  if (role === 'tool') {
    return {
      content: [
        {
          id: asString(m.tool_call_id) ?? '',
          output: m.content,
          type: 'tool_result',
        },
      ],
      role: 'tool',
    };
  }
  const content = [...openaiContentParts(m.content), ...openaiToolCalls(m.tool_calls)];
  return { content, role };
}

function openaiFromStream(events: unknown[]): NormalizedCall['response'] | null {
  // Chat Completions streams deltas; reassemble per choice index.
  const texts = new Map<number, string>();
  const tools = new Map<string, { id?: string; name?: string; args: string }>();
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const e of events) {
    if (!isObj(e)) {
      continue;
    }
    usage = (e.usage as Record<string, unknown> | undefined) ?? usage;
    const choice = asArray(e.choices)[0];
    if (!isObj(choice)) {
      continue;
    }
    finishReason = asString(choice.finish_reason) ?? finishReason;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const idx = asNumber(choice.index) ?? 0;
    if (isObj(delta)) {
      texts.set(idx, (texts.get(idx) ?? '') + (asString(delta.content) ?? ''));
      for (const tc of asArray(delta.tool_calls)) {
        if (!isObj(tc)) {
          continue;
        }
        const key = `${idx}:${asNumber(tc.index) ?? 0}`;
        const acc = tools.get(key) ?? { args: '' };
        acc.id ??= asString(tc.id);
        if (isObj(tc.function)) {
          acc.name ??= asString(tc.function.name);
          acc.args += asString(tc.function.arguments) ?? '';
        }
        tools.set(key, acc);
      }
    }
  }
  if (texts.size === 0 && tools.size === 0) {
    return null;
  }
  const content: NormalizedPart[] = [];
  const text = [...texts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, t]) => t)
    .join('');
  if (text) {
    content.push({ text, type: 'text' });
  }
  for (const t of tools.values()) {
    let input: unknown = t.args;
    try {
      input = JSON.parse(t.args || '{}');
    } catch {
      // keep raw
    }
    content.push({ id: t.id ?? '', input, name: t.name ?? '', type: 'tool_call' });
  }
  const u = usage;
  return {
    content,
    finishReason,
    usage: u
      ? {
          inputTokens: asNumber(u.prompt_tokens),
          outputTokens: asNumber(u.completion_tokens),
        }
      : undefined,
  };
}

function normalizeOpenAiChat(record: HttpCallLike): NormalizedCall | null {
  const req = isObj(record.request) ? record.request : null;
  if (!req) {
    return null;
  }
  const events = responseEvents(record);
  let response: NormalizedCall['response'] | null = null;
  let model = asString(req.model);
  const first = events[0];
  if (
    events.length === 1 &&
    isObj(first) &&
    asArray(first.choices).length > 0 &&
    !isObj(
      first.choices &&
        (first.choices as unknown[])[0] &&
        ((first.choices as unknown[])[0] as Record<string, unknown>).delta
    )
  ) {
    const choice = (first.choices as unknown[])[0] as Record<string, unknown>;
    const msg = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
    model = asString(first.model) ?? model;
    const u = first.usage as Record<string, unknown> | undefined;
    response = {
      content: msg ? [...openaiContentParts(msg.content), ...openaiToolCalls(msg.tool_calls)] : [],
      finishReason: asString(choice.finish_reason),
      usage: u
        ? {
            inputTokens: asNumber(u.prompt_tokens),
            outputTokens: asNumber(u.completion_tokens),
          }
        : undefined,
    };
  } else {
    response = openaiFromStream(events);
    for (const e of events) {
      if (isObj(e) && e.model) {
        model = asString(e.model) ?? model;
      }
    }
  }
  if (!response) {
    return null;
  }
  const messages: NormalizedMessage[] = [];
  let system: string | undefined;
  for (const m of asArray(req.messages)) {
    const msg = openaiMessage(m);
    if (!msg) {
      continue;
    }
    if (msg.role === 'system') {
      system = msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      messages.push(msg);
    } else {
      messages.push(msg);
    }
  }
  return {
    messages,
    model,
    provider: 'openai-chat',
    response,
    system,
    tools: asArray(req.tools).map((t) => {
      const f = isObj(t) && isObj(t.function) ? t.function : {};
      return {
        description: asString(f.description),
        inputSchema: f.parameters,
        name: asString(f.name) ?? '',
      };
    }),
  };
}

// ── OpenAI Responses API ────────────────────────────────────────────────────

function responsesOutputPart(item: unknown): NormalizedPart[] {
  if (!isObj(item)) {
    return [];
  }
  switch (item.type) {
    case 'message':
      return asArray(item.content).flatMap((c) => {
        if (!isObj(c)) {
          return [];
        }
        if (c.type === 'output_text' || c.type === 'text') {
          return [{ text: asString(c.text) ?? '', type: 'text' } as NormalizedPart];
        }
        if (c.type === 'refusal') {
          return [{ text: asString(c.refusal) ?? '', type: 'text' } as NormalizedPart];
        }
        return [];
      });
    case 'reasoning':
      return asArray(item.summary).length > 0
        ? [
            {
              text: asArray(item.summary)
                .map((s) => (isObj(s) ? asString(s.text) : undefined))
                .filter(Boolean)
                .join('\n'),
              type: 'reasoning',
            } as NormalizedPart,
          ]
        : [{ text: '', type: 'reasoning' }];
    case 'function_call': {
      let input: unknown = item.arguments;
      try {
        input = JSON.parse(asString(item.arguments) ?? '{}');
      } catch {
        // keep raw
      }
      return [
        {
          id: asString(item.call_id) ?? asString(item.id) ?? '',
          input,
          name: asString(item.name) ?? '',
          type: 'tool_call',
        },
      ];
    }
    case 'function_call_output':
      return [
        {
          id: asString(item.call_id) ?? '',
          output: item.output,
          type: 'tool_result',
        },
      ];
    default:
      return [];
  }
}

function normalizeOpenAiResponses(record: HttpCallLike): NormalizedCall | null {
  const req = isObj(record.request) ? record.request : null;
  if (!req) {
    return null;
  }
  const events = responseEvents(record);
  // The terminal `response.completed` event (or a plain JSON response) carries
  // the whole Response object.
  let resp: Record<string, unknown> | undefined;
  for (const e of events) {
    if (!isObj(e)) {
      continue;
    }
    if (e.type === 'response.completed' || e.type === 'response.incomplete') {
      const r = e.response;
      if (isObj(r)) {
        resp = r;
      }
    } else if (e.object === 'response' || Array.isArray(e.output)) {
      resp = e;
    }
  }
  if (!resp) {
    return null;
  }
  const u = resp.usage as Record<string, unknown> | undefined;
  const details = u?.input_tokens_details as Record<string, unknown> | undefined;
  const response: NormalizedCall['response'] = {
    content: asArray(resp.output).flatMap(responsesOutputPart),
    finishReason: asString(resp.status),
    usage: u
      ? {
          cacheRead: asNumber(details?.cached_tokens),
          inputTokens: asNumber(u.input_tokens),
          outputTokens: asNumber(u.output_tokens),
        }
      : undefined,
  };
  const inputItems = Array.isArray(req.input)
    ? req.input
    : req.input !== undefined
      ? [{ content: [{ text: req.input, type: 'input_text' }], role: 'user', type: 'message' }]
      : [];
  const messages = inputItems
    .map((item) => {
      if (!isObj(item)) {
        return null;
      }
      if (item.type === 'function_call_output') {
        return {
          content: [{ id: asString(item.call_id) ?? '', output: item.output, type: 'tool_result' }],
          role: 'tool',
        } as NormalizedMessage;
      }
      const role = String(item.role ?? 'user') as NormalizedMessage['role'];
      const content =
        asArray(item.content).length > 0
          ? asArray(item.content)
              .map((c) => {
                if (!isObj(c)) {
                  return null;
                }
                const t = asString(c.text);
                if (t === undefined) {
                  return null;
                }
                return { text: t, type: 'text' } as NormalizedPart;
              })
              .filter((p): p is NormalizedPart => p !== null)
          : typeof item.content === 'string'
            ? [{ text: item.content, type: 'text' } as NormalizedPart]
            : [];
      return { content, role } as NormalizedMessage;
    })
    .filter((m): m is NormalizedMessage => m !== null);
  return {
    messages,
    model: asString(resp.model) ?? asString(req.model),
    provider: 'openai-responses',
    response,
    system: asString(req.instructions),
    tools: asArray(req.tools).map((t) => {
      const tool = isObj(t) ? t : {};
      return {
        description: asString(tool.description),
        inputSchema: tool.parameters,
        name: asString(tool.name) ?? '',
      };
    }),
  };
}

// ── Google generateContent / streamGenerateContent ──────────────────────────

function googlePart(p: unknown): NormalizedPart | null {
  if (!isObj(p)) {
    return null;
  }
  if (typeof p.text === 'string') {
    return p.thought === true
      ? { text: p.text, type: 'reasoning' }
      : { text: p.text, type: 'text' };
  }
  if (isObj(p.functionCall)) {
    return {
      id: asString(p.functionCall.id) ?? asString(p.functionCall.name) ?? '',
      input: p.functionCall.args,
      name: asString(p.functionCall.name) ?? '',
      type: 'tool_call',
    };
  }
  if (isObj(p.functionResponse)) {
    return {
      id: asString(p.functionResponse.name) ?? '',
      output: p.functionResponse.response,
      type: 'tool_result',
    };
  }
  if (isObj(p.inlineData) || isObj(p.fileData)) {
    return { reference: 'media', type: 'image' };
  }
  return null;
}

function normalizeGoogle(record: HttpCallLike): NormalizedCall | null {
  const req = isObj(record.request) ? record.request : null;
  if (!req) {
    return null;
  }
  const events = responseEvents(record);
  // Streamed: the last chunk carries final usage; content is per-chunk parts.
  let respContent: NormalizedPart[] = [];
  let usage: NormalizedCall['response']['usage'];
  let finishReason: string | undefined;
  let model: string | undefined;
  for (const e of events) {
    if (!isObj(e)) {
      continue;
    }
    model = asString(e.modelVersion) ?? model;
    const meta = e.usageMetadata as Record<string, unknown> | undefined;
    if (meta) {
      usage = {
        cacheRead: asNumber(meta.cachedContentTokenCount),
        inputTokens: asNumber(meta.promptTokenCount),
        outputTokens:
          (asNumber(meta.candidatesTokenCount) ?? 0) + (asNumber(meta.thoughtsTokenCount) ?? 0),
      };
    }
    const candidate = asArray(e.candidates)[0];
    if (isObj(candidate)) {
      finishReason = asString(candidate.finishReason) ?? finishReason;
      respContent = asArray((candidate.content as Record<string, unknown> | undefined)?.parts)
        .map(googlePart)
        .filter((p): p is NormalizedPart => p !== null);
    }
  }
  if (respContent.length === 0 && !usage) {
    return null;
  }
  const system = (req.systemInstruction as Record<string, unknown> | undefined)?.parts;
  return {
    messages: asArray(req.contents)
      .map((c) => {
        if (!isObj(c)) {
          return null;
        }
        const role = c.role === 'model' ? 'assistant' : c.role === 'function' ? 'tool' : 'user';
        return {
          content: asArray(c.parts)
            .map(googlePart)
            .filter((p): p is NormalizedPart => p !== null),
          role: role as NormalizedMessage['role'],
        } as NormalizedMessage;
      })
      .filter((m): m is NormalizedMessage => m !== null),
    model,
    provider: 'google',
    response: { content: respContent, finishReason, usage },
    system: Array.isArray(system)
      ? system
          .map((p) => (isObj(p) ? asString(p.text) : undefined))
          .filter(Boolean)
          .join('\n')
      : undefined,
    tools: asArray(req.tools).flatMap((t) =>
      asArray(isObj(t) ? t.functionDeclarations : undefined).map((f) => {
        const fn = isObj(f) ? f : {};
        return {
          description: asString(fn.description),
          inputSchema: fn.parameters,
          name: asString(fn.name) ?? '',
        };
      })
    ),
  };
}

// ── Claude Code harness messages ────────────────────────────────────────────

/**
 * A non-proxied Claude Code turn's SDK message as a NormalizedCall. The
 * harness's system prompt and tool schemas are not on the message, so only
 * what the message carries is mapped.
 */
function normalizeHarnessMessage(record: RecordLike): NormalizedCall | null {
  const msg = record.message;
  if (!isObj(msg)) {
    return null;
  }
  if (msg.type === 'assistant' && isObj(msg.message)) {
    const inner = msg.message;
    return {
      messages: [anthropicMessage('assistant', inner.content)],
      model: asString(inner.model),
      provider: 'claude-code',
      response: { content: [] },
    };
  }
  if (msg.type === 'user' && isObj(msg.message)) {
    const inner = msg.message;
    const content = Array.isArray(inner.content)
      ? asArray(inner.content)
          .map(anthropicContentPart)
          .filter((p): p is NormalizedPart => p !== null)
      : [{ text: jsonText(inner.content), type: 'text' } as NormalizedPart];
    return {
      messages: [{ content, role: 'user' }],
      provider: 'claude-code',
      response: { content: [] },
    };
  }
  if (msg.type === 'result') {
    return {
      messages: [],
      provider: 'claude-code',
      response: {
        content: [{ text: asString(msg.result) ?? '', type: 'text' }],
        finishReason: asString(msg.subtype),
      },
    };
  }
  // system/init and other lifecycle messages normalize to an empty call.
  return {
    messages: [],
    provider: 'claude-code',
    response: { content: [] },
  };
}

/**
 * Normalize one transcript record. Returns `null` when the record's shape is
 * not one of the known provider APIs.
 */
export function normalizeTranscriptRecord(record: RecordLike): NormalizedCall | null {
  if (record.kind === 'harness_message') {
    return normalizeHarnessMessage(record);
  }
  if (record.kind !== 'http_call') {
    return null;
  }
  const path = record.path ?? '';
  if (path.includes('/v1/messages')) {
    return normalizeAnthropic(record);
  }
  if (path.endsWith('/responses') || path.includes('/responses?')) {
    return normalizeOpenAiResponses(record);
  }
  if (path.includes('/chat/completions')) {
    return normalizeOpenAiChat(record);
  }
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) {
    return normalizeGoogle(record);
  }
  return null;
}
