/**
 * A one-shot reachability check for an MCP server: connect over streamable HTTP, initialize, and
 * list its tools. It exists so an admin can tell "the URL is wrong" from "the server is fine"
 * before an agent's run depends on it.
 *
 * Like the worker, it tries streamable HTTP first and falls back to the legacy HTTP+SSE transport
 * (a URL ending `/sse` goes straight to it). A stored bearer token is sent as
 * `Authorization: Bearer …` on every request to the connection's own origin and nowhere else: a
 * redirect is never followed, and an SSE `endpoint` on another origin is refused before any
 * request is made to it.
 *
 * The result carries only fixed messages. A server controls its own error text, and a fetch error
 * can name the internal address that was tried, so neither is passed through. Redirects are never
 * followed: the SSRF guard approved one URL, not wherever it points.
 */

export interface McpProbeOptions {
  /** Plaintext token to send; the caller decrypts it and nothing here stores or logs it. */
  bearerToken?: string;
}

export interface McpProbeResult {
  ok: boolean;
  /** Fixed, human-readable reason when `ok` is false. */
  error?: string;
  toolCount?: number;
  /** The first few tool names, so the admin can recognise the server. */
  toolNames?: string[];
  durationMs: number;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_TOOL_NAMES = 12;
/** A stored per-connection timeout is admin-chosen; a probe never waits longer than this. */
const MAX_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2025-03-26';

class ProbeError extends Error {
  constructor(
    message: string,
    /** True when trying the other transport cannot help (auth, redirect, timeout). */
    readonly final = false
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const timeoutError = (timeoutMs: number) =>
  new ProbeError(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, true);

/**
 * Reads a body up to a size cap. For an event stream the answer to `id` may arrive while the
 * server holds the stream open, so each completed event is checked as it arrives (never the whole
 * buffer again) and reading stops once that message is complete. An abort mid-read is the same
 * timeout the request itself reports.
 */
async function readCapped(
  res: Response,
  id: number,
  eventStream: boolean,
  signal: AbortSignal,
  timeoutMs: number
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    return '';
  }
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (signal.aborted) {
      fail();
    } else {
      signal.addEventListener('abort', fail, { once: true });
    }
  });
  aborted.catch(() => undefined);
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let pending = '';
  let size = 0;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      // fetch aborts its own body, but racing the signal makes the deadline hold for any body.
      step = await Promise.race([reader.read(), aborted]);
    } catch (err) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw timeoutError(timeoutMs);
      }
      void err;
      throw new ProbeError('The connection to the server broke while reading its answer.');
    }
    if (step.done) {
      break;
    }
    size += step.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ProbeError('The server sent a response that was too large to read.');
    }
    chunks.push(step.value);
    if (eventStream) {
      // Only complete events (ended by a blank line) are parsed; the tail waits for more bytes.
      pending += decoder.decode(step.value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const event of events) {
        try {
          rpcMessage(event, 'text/event-stream', id);
        } catch {
          continue; // Some other event; keep reading.
        }
        await reader.cancel();
        return `${event}\n\n`;
      }
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON-RPC message answering `id`, from either a plain JSON or an event-stream body. */
function rpcMessage(body: string, contentType: string, id: number): Record<string, unknown> {
  const candidates: string[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) {
        candidates.push(data);
      }
    }
  } else {
    candidates.push(body);
  }
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const hit = list.find(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id
      );
      if (hit) {
        return hit;
      }
    } catch {
      // Not JSON; try the next event.
    }
  }
  throw new ProbeError('The server did not answer with a valid MCP response.');
}

const MAX_EVENT_BYTES = MAX_BODY_BYTES;

interface SseEvent {
  event: string;
  data: string;
}

function parseSseEvent(raw: string): SseEvent {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { data: data.join('\n'), event };
}

/** A held-open legacy SSE stream: events are pulled one at a time, each read raced to the deadline. */
class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly queue: SseEvent[] = [];
  private pending = '';
  private size = 0;

  constructor(
    res: Response,
    private readonly signal: AbortSignal,
    private readonly timeoutMs: number
  ) {
    const reader = res.body?.getReader();
    if (!reader) {
      throw new ProbeError('The server did not answer with a valid MCP response.');
    }
    this.reader = reader;
  }

  async next(): Promise<SseEvent> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        return queued;
      }
      let step: Awaited<ReturnType<typeof this.reader.read>>;
      try {
        step = await Promise.race([
          this.reader.read(),
          new Promise<never>((_, reject) => {
            if (this.signal.aborted) {
              reject(new Error('aborted'));
            }
            this.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
        ]);
      } catch {
        if (this.signal.aborted) {
          throw timeoutError(this.timeoutMs);
        }
        throw new ProbeError('The connection to the server broke while reading its answer.');
      }
      if (step.done) {
        throw new ProbeError('The server closed the event stream before answering.');
      }
      this.size += step.value.byteLength;
      if (this.size > MAX_EVENT_BYTES) {
        throw new ProbeError('The server sent a response that was too large to read.');
      }
      this.pending += this.decoder.decode(step.value, { stream: true });
      const events = this.pending.split(/\r?\n\r?\n/);
      this.pending = events.pop() ?? '';
      for (const raw of events) {
        this.queue.push(parseSseEvent(raw));
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

export async function probeMcpServer(
  url: string,
  timeoutMs: number,
  fetchImpl: Fetch = fetch,
  opts: McpProbeOptions = {}
): Promise<McpProbeResult> {
  const started = Date.now();
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  const origin = new URL(url).origin;
  const authHeaders: Record<string, string> = opts.bearerToken
    ? { authorization: `Bearer ${opts.bearerToken}` }
    : {};

  /**
   * Every request goes through here. The token is attached only when the target is the
   * connection's own origin; any other target is a bug and is refused before it is sent.
   */
  const send = async (target: string, init: RequestInit): Promise<Response> => {
    if (new URL(target).origin !== origin) {
      throw new ProbeError(
        'The server pointed at a different address, which is not followed.',
        true
      );
    }
    let res: Response;
    try {
      res = await fetchImpl(target, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...authHeaders },
        redirect: 'manual',
        signal: init.signal ?? signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw timeoutError(timeoutMs);
      }
      void err;
      throw new ProbeError('Could not connect to the server.');
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProbeError('The server redirected the request, which is not followed.', true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProbeError(
        opts.bearerToken
          ? 'The server rejected the stored bearer token.'
          : 'The server requires authentication. Add a bearer token to this connection.',
        true
      );
    }
    if (!res.ok) {
      throw new ProbeError(`The server answered with HTTP ${res.status}.`);
    }
    return res;
  };

  const summarise = (result: Record<string, unknown>): McpProbeResult => {
    const tools = Array.isArray(result.tools) ? result.tools : [];
    const names = tools
      .map((t) => (t as { name?: unknown }).name)
      .filter((n): n is string => typeof n === 'string');
    return {
      durationMs: Date.now() - started,
      ok: true,
      toolCount: tools.length,
      toolNames: names.slice(0, MAX_TOOL_NAMES),
    };
  };

  const initParams = {
    capabilities: {},
    clientInfo: { name: 'auto-swe-connection-test', version: '1.0.0' },
    protocolVersion: PROTOCOL_VERSION,
  };

  const streamable = async (): Promise<McpProbeResult> => {
    let sessionId: string | null = null;
    const post = (payload: Record<string, unknown>) =>
      send(url, {
        body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        method: 'POST',
      });
    const call = async (id: number, method: string, params: Record<string, unknown>) => {
      const res = await post({ id, method, params });
      const header = res.headers.get('mcp-session-id');
      if (header) {
        sessionId = header;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const message = rpcMessage(
        await readCapped(res, id, contentType.includes('text/event-stream'), signal, timeoutMs),
        contentType,
        id
      );
      if (message.error) {
        throw new ProbeError('The server refused the request.', true);
      }
      return (message.result ?? {}) as Record<string, unknown>;
    };
    try {
      await call(1, 'initialize', initParams);
      const initialized = await post({ method: 'notifications/initialized' });
      await initialized.body?.cancel();
      return summarise(await call(2, 'tools/list', {}));
    } finally {
      // Best effort: tell a stateful server the session is over so it does not hold it open.
      if (sessionId) {
        try {
          await send(url, {
            headers: { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-session-id': sessionId },
            method: 'DELETE',
            signal: AbortSignal.timeout(2000),
          });
        } catch {
          // The probe's verdict stands whether or not the server accepted the close.
        }
      }
    }
  };

  /** Legacy HTTP+SSE: GET the stream, learn the POST endpoint from its first event, then answer on it. */
  const legacySse = async (): Promise<McpProbeResult> => {
    const res = await send(url, {
      headers: { accept: 'text/event-stream' },
      method: 'GET',
    });
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProbeError('The server did not answer with a valid MCP response.');
    }
    const stream = new SseStream(res, signal, timeoutMs);
    try {
      let endpoint: string | null = null;
      while (!endpoint) {
        const ev = await stream.next();
        if (ev.event === 'endpoint' && ev.data) {
          try {
            endpoint = new URL(ev.data, url).toString();
          } catch {
            throw new ProbeError('The server did not answer with a valid MCP response.');
          }
        }
      }
      // `send` refuses a different origin before anything, the token included, is sent to it.
      const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
        const ack = await send(endpoint as string, {
          body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        await ack.body?.cancel().catch(() => undefined);
        for (;;) {
          const ev = await stream.next();
          if (ev.event !== 'message' || !ev.data) {
            continue;
          }
          let parsed: { id?: unknown; error?: unknown; result?: unknown };
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            continue;
          }
          if (parsed.id !== id) {
            continue;
          }
          if (parsed.error) {
            throw new ProbeError('The server refused the request.', true);
          }
          return (parsed.result ?? {}) as Record<string, unknown>;
        }
      };
      await rpc(1, 'initialize', initParams);
      const note = await send(endpoint, {
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      await note.body?.cancel().catch(() => undefined);
      return summarise(await rpc(2, 'tools/list', {}));
    } finally {
      await stream.close();
    }
  };

  const failure = (err: unknown): McpProbeResult => ({
    durationMs: Date.now() - started,
    error: err instanceof ProbeError ? err.message : 'The check failed unexpectedly.',
    ok: false,
  });

  if (new URL(url).pathname.endsWith('/sse')) {
    try {
      return await legacySse();
    } catch (err) {
      return failure(err);
    }
  }
  try {
    return await streamable();
  } catch (err) {
    if (err instanceof ProbeError && err.final) {
      return failure(err);
    }
    // Streamable HTTP failed in a way another transport might fix. If it does not either, the
    // streamable error is the one reported: it is the transport the connection is expected to use.
    try {
      return await legacySse();
    } catch (sseErr) {
      return failure(sseErr instanceof ProbeError && sseErr.final ? sseErr : err);
    }
  }
}
