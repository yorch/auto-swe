import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createModelProxy,
  MessagesUsageReader,
  type ModelProxy,
  type ProxiedCall,
} from './modelProxy.js';

interface Seen {
  apiKey: string | undefined;
  authorization: string | undefined;
  url: string;
  body: string;
}

/** A provider stand-in: records what reached it and answers per `reply`. */
async function upstreamServer(
  reply: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    seen.push({
      apiKey: req.headers['x-api-key'] as string | undefined,
      authorization: req.headers.authorization,
      body,
      url: req.url ?? '',
    });
    await reply(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    seen,
  };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamedReply(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
  res.write(
    sse('message_start', {
      message: {
        id: 'msg_1',
        model: 'claude-opus-5-5',
        usage: {
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 40,
          input_tokens: 100,
          output_tokens: 1,
        },
      },
      type: 'message_start',
    })
  );
  res.write(sse('content_block_delta', { delta: { text: 'hi' }, type: 'content_block_delta' }));
  res.write(sse('message_delta', { type: 'message_delta', usage: { output_tokens: 30 } }));
  res.end(sse('message_stop', { type: 'message_stop' }));
}

let upstream: Awaited<ReturnType<typeof upstreamServer>>;
let proxy: ModelProxy;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
});

async function setup(reply: Parameters<typeof upstreamServer>[0]) {
  upstream = await upstreamServer(reply);
  proxy = createModelProxy({
    advertisedUrl: (port) => `http://127.0.0.1:${port}`,
    listenHost: '127.0.0.1',
    listenPort: 0,
  });
  const calls: ProxiedCall[] = [];
  const abort = new AbortController();
  const registration = await proxy.register({
    apiKey: 'sk-ant-real',
    onCall: (call) => calls.push(call),
    signal: abort.signal,
    upstreamBaseUrl: upstream.baseUrl,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${registration.baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': registration.token,
        ...headers,
      },
      method: 'POST',
    });
  return { abort, calls, post, registration };
}

describe('createModelProxy', () => {
  it('relays a streamed call with the real key, unchanged, and meters it once it ends', async () => {
    const { calls, post, registration } = await setup((_req, res) => streamedReply(res));

    const res = await post('/v1/messages?beta=true', { model: 'claude-opus-5-5', stream: true });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text":"hi"');
    // Upstream sees the real key, never the turn's token, at the path the harness asked for.
    expect(upstream.seen[0]).toMatchObject({
      apiKey: 'sk-ant-real',
      url: '/v1/messages?beta=true',
    });
    expect(JSON.stringify(upstream.seen[0])).not.toContain(registration.token);

    await registration.release();
    expect(calls).toEqual([
      {
        id: 'call-1',
        model: 'claude-opus-5-5',
        usage: { cacheRead: 40, cacheWrite: 5, input: 100, output: 30 },
      },
    ]);
  });

  it('meters a plain JSON response, and leaves a token count and an error unmetered', async () => {
    const { calls, post, registration } = await setup((req, res) => {
      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 12 }));
      } else if (upstream.seen.length === 3) {
        res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '3' });
        res.end(JSON.stringify({ error: { type: 'overloaded_error' }, type: 'error' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_side',
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 7, output_tokens: 3 },
          })
        );
      }
    });

    expect((await post('/v1/messages', { model: 'claude-haiku-4-5-20251001' })).status).toBe(200);
    expect((await post('/v1/messages/count_tokens', { model: 'x' })).status).toBe(200);
    const overloaded = await post('/v1/messages', { model: 'x' });
    // The harness sees the provider's answer, retry hints included.
    expect(overloaded.status).toBe(529);
    expect(overloaded.headers.get('retry-after')).toBe('3');

    await registration.release();
    expect(calls).toEqual([
      {
        id: 'call-1',
        model: 'claude-haiku-4-5-20251001',
        usage: { cacheRead: 0, cacheWrite: 0, input: 7, output: 3 },
      },
    ]);
  });

  it('refuses an unknown token, another endpoint, and a released turn', async () => {
    const { post, registration } = await setup((_req, res) => streamedReply(res));

    expect((await post('/v1/messages', {}, { 'x-api-key': 'sk-ant-guess' })).status).toBe(401);
    expect((await post('/v1/files', {})).status).toBe(404);
    const get = await fetch(`${registration.baseUrl}/v1/messages`, {
      headers: { 'x-api-key': registration.token },
    });
    expect(get.status).toBe(404);

    await registration.release();
    expect((await post('/v1/messages', {})).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it('accepts the token as a bearer credential too', async () => {
    const { post, registration } = await setup((_req, res) => streamedReply(res));
    const res = await post(
      '/v1/messages',
      {},
      {
        authorization: `Bearer ${registration.token}`,
        'x-api-key': '',
      }
    );
    expect(res.status).toBe(200);
    await res.text();
    // Only the real key travels upstream.
    expect(upstream.seen[0]).toMatchObject({ apiKey: 'sk-ant-real', authorization: undefined });
  });

  it('cuts off what is in flight when the turn is aborted, reports what it was billed, and refuses new calls', async () => {
    const { abort, calls, post, registration } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse('message_start', {
          message: {
            id: 'msg_cut',
            model: 'claude-opus-5-5',
            usage: { input_tokens: 50, output_tokens: 1 },
          },
          type: 'message_start',
        })
      );
      // …and never finishes.
    });

    const response = await post('/v1/messages', { stream: true });
    const body = response.body?.getReader();
    // The harness has the call's first event: the proxy has read it on the way.
    await body?.read();
    abort.abort();
    await body?.read().catch(() => undefined);
    await registration.release();

    expect(calls).toEqual([
      {
        id: 'call-1',
        model: 'claude-opus-5-5',
        usage: { cacheRead: 0, cacheWrite: 0, input: 50, output: 1 },
      },
    ]);
    // A token for an aborted turn spends nothing more.
    const refused = await fetch(`${registration.baseUrl}/v1/messages`, {
      body: '{}',
      headers: { 'x-api-key': registration.token },
      method: 'POST',
    });
    expect(refused.status).toBe(401);
  });

  it('refuses a call for a turn whose signal has already aborted, without reaching the provider', async () => {
    const { abort, post } = await setup((_req, res) => streamedReply(res));
    abort.abort();
    expect((await post('/v1/messages', {})).status).toBe(403);
    expect(upstream.seen).toHaveLength(0);
  });

  it('reports each call in the context of the activity that registered the turn', async () => {
    upstream = await upstreamServer((_req, res) => streamedReply(res));
    proxy = createModelProxy({
      advertisedUrl: (port) => `http://127.0.0.1:${port}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
    });
    const activity = new AsyncLocalStorage<string>();
    const seenIn: (string | undefined)[] = [];
    const registration = await activity.run('activity-1', () =>
      proxy.register({
        apiKey: 'k',
        onCall: () => seenIn.push(activity.getStore()),
        signal: new AbortController().signal,
        upstreamBaseUrl: upstream.baseUrl,
      })
    );
    const res = await fetch(`${registration.baseUrl}/v1/messages`, {
      body: '{}',
      headers: { 'x-api-key': registration.token },
      method: 'POST',
    });
    await res.text();
    await registration.release();
    expect(seenIn).toEqual(['activity-1']);
  });
});

describe('MessagesUsageReader', () => {
  let reader: MessagesUsageReader;
  beforeEach(() => {
    reader = new MessagesUsageReader('text/event-stream; charset=utf-8');
  });

  it('reads events split anywhere across chunks', () => {
    const stream =
      sse('message_start', {
        message: { id: 'm', model: 'claude-x', usage: { input_tokens: 9, output_tokens: 1 } },
        type: 'message_start',
      }) + sse('message_delta', { type: 'message_delta', usage: { output_tokens: 4 } });
    for (let i = 0; i < stream.length; i += 7) {
      reader.write(stream.slice(i, i + 7));
    }
    expect(reader.result(undefined)).toEqual({
      model: 'claude-x',
      usage: { cacheRead: 0, cacheWrite: 0, input: 9, output: 4 },
    });
  });

  it('has nothing to report for a stream that carried no usage', () => {
    reader.write(sse('ping', { type: 'ping' }));
    expect(reader.result('claude-x')).toBeUndefined();
  });
});
