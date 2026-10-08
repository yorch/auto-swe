import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { modelCallFetch } from '@auto-swe/shared/lib/modelDiscovery';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import type { UsageTotals } from '../harness/usage.js';

/**
 * The model calls a harness turn may make through the proxy: the Messages API
 * and its free token counter. Anything else is refused — the token is good for
 * spending on the turn's model calls, not for the provider's other endpoints.
 */
const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const METERED_PATH = '/v1/messages';

/** A request body larger than this is refused; a harness turn's context fits well inside it. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * Request headers passed upstream. The harness's own credential headers are
 * not among them: the proxy sends the real key, and only to the configured host.
 */
const FORWARDED_REQUEST_HEADERS = ['anthropic-beta', 'anthropic-version', 'content-type', 'accept'];

/** Response headers never passed back: hop-by-hop, and those fetch has already acted on. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);

/** One model call the proxy saw complete (or cut off), with what it was billed. */
export interface ProxiedCall {
  /**
   * The proxy's own id for the request: unique per call, whatever the provider
   * names its messages (a gateway may not name them at all).
   */
  id: string;
  /** The model the provider answered with (`claude-…`), else the one requested. */
  model: string;
  usage: UsageTotals;
}

export interface ProxyRegistration {
  /** What the harness uses as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  /** What the harness uses as its API key. Good only for this turn, only at this proxy. */
  token: string;
  /**
   * Revokes the token, aborts what is still in flight, and resolves once every
   * call the turn made has been reported to `onCall`.
   */
  release(): Promise<void>;
}

export interface ModelProxy {
  register(turn: {
    /** The provider the calls go to (`https://api.anthropic.com`, or a gateway), without `/v1`. */
    upstreamBaseUrl: string;
    /** The real credential. It never leaves the worker. */
    apiKey: string;
    /** Each call, once its response has ended. Runs in the registering activity's context. */
    onCall(call: ProxiedCall): void;
    /** Aborted: in-flight calls are cut off and new ones refused. */
    signal: AbortSignal;
  }): Promise<ProxyRegistration>;
  /** Starts listening (registering does too) and resolves to the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

interface Registration {
  upstreamBaseUrl: string;
  apiKey: string;
  onCall: (call: ProxiedCall) => void;
  signal: AbortSignal;
  inFlight: Set<Promise<void>>;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The usage of one Messages API response, read as it streams past.
 *
 * A streamed response reports the call's input (and cache) usage in
 * `message_start` and its output in `message_delta`, cumulatively; a plain JSON
 * response carries the whole `usage` object. A stream cut off before its
 * `message_delta` reports the input it was billed and the output the provider
 * had reported by then.
 */
export class MessagesUsageReader {
  private model: string | undefined;
  private usage: UsageTotals = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
  private seen = false;
  private pending = '';
  private readonly json: boolean;
  private body = '';

  constructor(contentType: string | null) {
    this.json = !(contentType ?? '').includes('text/event-stream');
  }

  write(chunk: string): void {
    if (this.json) {
      this.body += chunk;
      return;
    }
    this.pending += chunk;
    let end = this.pending.indexOf('\n');
    while (end !== -1) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      if (line.startsWith('data:')) {
        this.event(line.slice(5).trim());
      }
      end = this.pending.indexOf('\n');
    }
  }

  /** The call's usage, or `undefined` when the response carried none (an error, a count). */
  result(
    fallbackModel: string | undefined
  ): (Omit<ProxiedCall, 'id'> & { id?: string }) | undefined {
    if (this.json) {
      this.event(this.body);
    }
    if (!this.seen) {
      return undefined;
    }
    return { model: this.model ?? fallbackModel ?? 'unknown', usage: this.usage };
  }

  private event(data: string): void {
    let parsed: {
      type?: string;
      model?: string;
      usage?: Record<string, number | null>;
      message?: { model?: string; usage?: Record<string, number | null> };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const message = parsed.type === 'message_start' ? parsed.message : parsed;
    if (message?.model) {
      this.model = message.model;
    }
    const u = message?.usage ?? (parsed.type === 'message_delta' ? parsed.usage : undefined);
    if (u) {
      this.seen = true;
      // Each report is cumulative for the fields it carries.
      this.usage = {
        cacheRead: u.cache_read_input_tokens ?? this.usage.cacheRead,
        cacheWrite: u.cache_creation_input_tokens ?? this.usage.cacheWrite,
        input: u.input_tokens ?? this.usage.input,
        output: u.output_tokens ?? this.usage.output,
      };
    }
  }
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type }, type: 'error' }));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function credentialOf(req: http.IncomingMessage): string | undefined {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key) {
    return key;
  }
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/**
 * A metering proxy between a harness and its model provider, in the worker.
 *
 * A harness turn registers and gets a random token and the proxy's address in
 * place of the real key and the provider's: the container never holds the
 * credential, and a token read out of it is good only for that turn's model
 * calls, only at this proxy, only until the turn ends. Every call passes
 * through here, so each is metered exactly when its response ends — including
 * calls the harness makes without streaming a message — and a turn whose
 * budget ran out (its signal aborted) has its in-flight calls cut off and new
 * ones refused.
 *
 * `listenHost`/`listenPort` are where the worker accepts calls; `advertisedUrl`
 * is how a workspace container reaches it (given the bound port, for a proxy
 * listening on port 0).
 */
export function createModelProxy(options: {
  listenHost: string;
  listenPort: number;
  advertisedUrl: string | ((port: number) => string);
  /** Replaces the guarded fetch to the provider. Tests only. */
  upstreamFetch?: typeof fetch;
}): ModelProxy {
  // The upstream is a credential's apiBase: resolved, checked and pinned like
  // every other model call, so the proxy cannot be pointed at an internal host.
  const upstreamFetch = options.upstreamFetch ?? modelCallFetch();
  const registrations = new Map<string, Registration>();
  let callSeq = 0;

  async function forward(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    search: string
  ): Promise<void> {
    const body = await readBody(req);
    if (!body) {
      sendError(res, 413, 'request_too_large', 'Request body too large.');
      return;
    }
    let requestedModel: string | undefined;
    try {
      requestedModel = (JSON.parse(body.toString('utf8')) as { model?: string }).model;
    } catch {
      // Not JSON: the provider will say so.
    }

    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
    headers['x-api-key'] = reg.apiKey;

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    reg.signal.addEventListener('abort', onAbort, { once: true });
    res.on('close', onAbort);

    const metered = path === METERED_PATH;
    let reader: MessagesUsageReader | undefined;
    try {
      const upstream = await upstreamFetch(`${reg.upstreamBaseUrl}${path}${search}`, {
        body,
        headers,
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) {
          responseHeaders[name] = value;
        }
      });
      res.writeHead(upstream.status, responseHeaders);
      if (metered && upstream.ok) {
        reader = new MessagesUsageReader(upstream.headers.get('content-type'));
      }
      if (upstream.body) {
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          reader?.write(decoder.decode(chunk, { stream: true }));
          if (!res.write(chunk)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.on('drain', done);
              res.on('close', done);
            });
          }
          if (abort.signal.aborted) {
            break;
          }
        }
      }
      res.end();
    } catch {
      // The provider failed or the turn was cut off: the harness sees a failed
      // call (and retries or ends, as it would against the provider itself).
      sendError(res, 502, 'api_error', 'The model call could not be completed.');
    } finally {
      reg.signal.removeEventListener('abort', onAbort);
      res.off('close', onAbort);
      const used = reader?.result(requestedModel);
      if (used) {
        callSeq += 1;
        reg.onCall({ id: `call-${callSeq}`, model: used.model, usage: used.usage });
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const token = credentialOf(req);
    const reg = token ? registrations.get(digest(token)) : undefined;
    if (!reg) {
      sendError(res, 401, 'authentication_error', 'Unknown or expired token.');
      return;
    }
    if (req.method !== 'POST' || !ALLOWED_PATHS.has(url.pathname)) {
      sendError(res, 404, 'not_found_error', 'Only the Messages API is available here.');
      return;
    }
    if (reg.signal.aborted) {
      sendError(res, 403, 'permission_error', 'This turn has ended; no further model calls.');
      return;
    }
    const call = forward(reg, req, res, url.pathname, url.search).catch(() => {
      sendError(res, 502, 'api_error', 'The model call could not be completed.');
    });
    reg.inFlight.add(call);
    void call.finally(() => reg.inFlight.delete(call));
  });
  // A streamed turn can sit quiet for a long time between events.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let listening: Promise<number> | undefined;
  const listen = () => {
    listening ??= new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.listenPort, options.listenHost, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    }).catch((err: unknown) => {
      listening = undefined;
      throw err;
    });
    return listening;
  };

  return {
    async close() {
      if (listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
      }
    },
    listen,
    async register(turn) {
      const port = await listen();
      const baseUrl =
        typeof options.advertisedUrl === 'function'
          ? options.advertisedUrl(port)
          : options.advertisedUrl;
      const token = `sk-ant-proxy-${randomBytes(32).toString('hex')}`;
      const key = digest(token);
      const reg: Registration = {
        apiKey: turn.apiKey,
        inFlight: new Set(),
        // Bound here so the debit it triggers runs in the registering activity's
        // context (its workflow id, its cancellation), not the server's.
        onCall: AsyncResource.bind(turn.onCall),
        signal: turn.signal,
        upstreamBaseUrl: turn.upstreamBaseUrl,
      };
      registrations.set(key, reg);
      let released: Promise<void> | undefined;
      return {
        baseUrl,
        release: () => {
          released ??= (async () => {
            registrations.delete(key);
            await Promise.allSettled([...reg.inFlight]);
          })();
          return released;
        },
        token,
      };
    },
  };
}

let shared: ModelProxy | null | undefined;

/**
 * The worker's model proxy, started on first use, or `null` when the deployment
 * has not configured one (`HARNESS_MODEL_PROXY_PORT`): the harness then holds
 * the credential itself, as it did before the proxy existed.
 */
export function workerModelProxy(): ModelProxy | null {
  if (shared === undefined) {
    const config = resolveWorkspaceInfra().harnessModelProxy;
    shared = config
      ? createModelProxy({
          advertisedUrl: config.url,
          listenHost: config.bindHost,
          listenPort: config.port,
        })
      : null;
  }
  return shared;
}
