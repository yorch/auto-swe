/**
 * A one-shot reachability check for an MCP server: connect over streamable HTTP, initialize, and
 * list its tools. It exists so an admin can tell "the URL is wrong" from "the server is fine"
 * before an agent's run depends on it.
 *
 * The result carries only fixed messages. A server controls its own error text, and a fetch error
 * can name the internal address that was tried, so neither is passed through. Redirects are never
 * followed: the SSRF guard approved one URL, not wherever it points.
 */

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

class ProbeError extends Error {}

type Fetch = typeof fetch;

const timeoutError = (timeoutMs: number) =>
  new ProbeError(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);

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

export async function probeMcpServer(
  url: string,
  timeoutMs: number,
  fetchImpl: Fetch = fetch
): Promise<McpProbeResult> {
  const started = Date.now();
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  let sessionId: string | null = null;

  const post = async (payload: Record<string, unknown>): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        method: 'POST',
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw timeoutError(timeoutMs);
      }
      void err;
      throw new ProbeError('Could not connect to the server.');
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProbeError('The server redirected the request, which is not followed.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProbeError(
        'The server requires authentication, which this connection cannot send.'
      );
    }
    if (!res.ok) {
      throw new ProbeError(`The server answered with HTTP ${res.status}.`);
    }
    return res;
  };

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
      throw new ProbeError('The server refused the request.');
    }
    return (message.result ?? {}) as Record<string, unknown>;
  };

  try {
    await call(1, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'auto-swe-connection-test', version: '1.0.0' },
      protocolVersion: PROTOCOL_VERSION,
    });
    const initialized = await post({ method: 'notifications/initialized' });
    await initialized.body?.cancel();
    const result = await call(2, 'tools/list', {});
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
  } catch (err) {
    return {
      durationMs: Date.now() - started,
      error: err instanceof ProbeError ? err.message : 'The check failed unexpectedly.',
      ok: false,
    };
  } finally {
    // Best effort: tell a stateful server the session is over so it does not hold it open.
    if (sessionId) {
      try {
        await fetchImpl(url, {
          headers: { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-session-id': sessionId },
          method: 'DELETE',
          redirect: 'manual',
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // The probe's verdict stands whether or not the server accepted the close.
      }
    }
  }
}
