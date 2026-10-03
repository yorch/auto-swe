import http from 'node:http';

/** What the harness sent to the model API, as the mock saw it. */
export interface MockApiRequest {
  apiKey: string | undefined;
  /**
   * The first message of the conversation, serialized. The harness puts the
   * repository's `CLAUDE.md` here, in the user turn, not in the system prompt.
   */
  firstMessage: string;
  /** The conversation length: 1 on the first request of a session, more once resumed. */
  messageCount: number;
  model: string | undefined;
  system: string;
  tools: string[];
  url: string;
}

export interface MockMessagesApi {
  close(): Promise<void>;
  port: number;
  /** Requests to `/v1/messages`, in order. */
  requests: MockApiRequest[];
}

type Block =
  | { id: string; input: { command: string; description: string }; name: string; type: 'tool_use' }
  | { text: string; type: 'text' };

const COMMANDS = [
  ['HANG', 'sleep 300'],
  ['DENY', 'echo forbidden'],
] as const;

/**
 * A just-enough Anthropic Messages API, so the Claude Code binary can be driven
 * end to end without a key: a task that carries the word `HANG` or `DENY` asks
 * for that shell command, any other asks for one that writes `out.txt`, and once
 * a tool result is in the conversation the next reply is the final text. Every
 * reply reports 100 input and 20 output tokens.
 *
 * Test infrastructure only; nothing in the worker imports it.
 */
export function startMockMessagesApi(): Promise<MockMessagesApi> {
  const requests: MockApiRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!req.url?.includes('/v1/messages')) {
        res.writeHead(404).end('{}');
        return;
      }
      const body = JSON.parse(raw || '{}') as {
        messages?: { content?: unknown }[];
        model?: string;
        stream?: boolean;
        system?: string | { text?: string }[];
        tools?: { name: string }[];
      };
      const messages = body.messages ?? [];
      const tools = (body.tools ?? []).map((t) => t.name);
      requests.push({
        apiKey: req.headers['x-api-key'] as string | undefined,
        firstMessage: JSON.stringify(messages[0] ?? ''),
        messageCount: messages.length,
        model: body.model,
        system: Array.isArray(body.system)
          ? body.system.map((s) => s.text ?? '').join('\n')
          : (body.system ?? ''),
        tools,
        url: req.url,
      });

      const hasToolResult = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')
      );
      const task = JSON.stringify(messages[0] ?? '');
      const asksForTool = tools.includes('Bash') && !hasToolResult;
      const command =
        COMMANDS.find(([word]) => task.includes(word))?.[1] ??
        'echo hello > out.txt && cat out.txt';
      const content: Block[] = asksForTool
        ? [
            {
              id: 'toolu_1',
              input: { command, description: 'mock' },
              name: 'Bash',
              type: 'tool_use',
            },
          ]
        : [{ text: hasToolResult ? 'all done' : 'ok', type: 'text' }];
      const stop = asksForTool ? 'tool_use' : 'end_turn';
      const message = {
        content,
        id: 'msg_1',
        model: body.model,
        role: 'assistant',
        stop_reason: stop,
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 100, output_tokens: 20 },
      };

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', {
        message: { ...message, content: [], stop_reason: null },
        type: 'message_start',
      });
      content.forEach((block, index) => {
        if (block.type === 'tool_use') {
          send('content_block_start', {
            content_block: { ...block, input: {} },
            index,
            type: 'content_block_start',
          });
          send('content_block_delta', {
            delta: { partial_json: JSON.stringify(block.input), type: 'input_json_delta' },
            index,
            type: 'content_block_delta',
          });
        } else {
          send('content_block_start', {
            content_block: { text: '', type: 'text' },
            index,
            type: 'content_block_start',
          });
          send('content_block_delta', {
            delta: { text: block.text, type: 'text_delta' },
            index,
            type: 'content_block_delta',
          });
        }
        send('content_block_stop', { index, type: 'content_block_stop' });
      });
      send('message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        type: 'message_delta',
        usage: { output_tokens: 20 },
      });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });

  return new Promise((resolve) =>
    // Every interface: the harness reaches it from inside a container, on the bridge.
    server.listen(0, '0.0.0.0', () =>
      resolve({
        close: () => new Promise((done) => server.close(() => done())),
        port: (server.address() as { port: number }).port,
        requests,
      })
    )
  );
}
