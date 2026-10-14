/**
 * Keeps a template's webhook token out of request logs and traces.
 *
 * `POST /api/v1/webhooks/:token` is authenticated by the token in its path, so
 * the URL itself is a credential. Fastify's default request serializer logs
 * `req.url` on every request, and the HTTP instrumentation records it on the
 * server span; either would put a working trigger credential in Loki or Tempo
 * for anyone who can read them. Everything that writes a request URL to
 * telemetry goes through {@link redactRequestUrl} instead.
 *
 * The named routes under the same prefix carry no secret in their path and are
 * left readable, so a log line still says which provider called.
 */

const WEBHOOK_PREFIX = '/api/v1/webhooks/';

/** Path segments under the prefix that name a route, not a token. */
const NAMED_WEBHOOK_ROUTES: ReadonlySet<string> = new Set(['access', 'ci', 'git', 'jira', 'slack']);

export const REDACTED_SEGMENT = '[redacted]';

/**
 * Percent-decode every escape except `%2F` (an encoded slash is not a path separator to the
 * router, so decoding it would move segment boundaries). Malformed escapes are left as they are.
 * The router matches a path like `/api/v1/%77ebhooks/<token>` to the webhook route, so matching
 * the prefix has to happen on the decoded form or the token slips through.
 */
function decodePath(path: string): string {
  return path.replace(/%([0-9a-fA-F]{2})/g, (seq, hex: string) =>
    hex.toLowerCase() === '2f' ? seq : String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/**
 * `url` with a webhook token in its path replaced by `[redacted]`. The query string is kept;
 * anything not under the webhook prefix is returned unchanged. The prefix is matched
 * case-insensitively and after percent-decoding; when a token is found the decoded path is
 * returned, since the encoded spelling of the token is as much a credential as the plain one.
 */
export function redactRequestUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? '' : url.slice(cut);
  const decoded = decodePath(path);
  const at = decoded.toLowerCase().indexOf(WEBHOOK_PREFIX);
  if (at === -1) {
    return url;
  }
  const start = at + WEBHOOK_PREFIX.length;
  let end = start;
  while (end < decoded.length && decoded[end] !== '/') {
    end++;
  }
  const segment = decoded.slice(start, end);
  if (segment.length === 0 || NAMED_WEBHOOK_ROUTES.has(segment.toLowerCase())) {
    return url;
  }
  return `${decoded.slice(0, start)}${REDACTED_SEGMENT}${decoded.slice(end)}${rest}`;
}

/**
 * Every URL-like word in a log message, redacted. Fastify writes some lines with the URL inside
 * the message text rather than in `req` — the not-found handler's `Route POST:/… not found` — and
 * the request serializer never sees those.
 */
export function redactLogText(text: string): string {
  if (!/webhooks|%/i.test(text)) {
    return text;
  }
  return text.replace(/\S+/g, (word) => redactRequestUrl(word));
}

/**
 * A pino `hooks.logMethod` that runs every string argument through {@link redactLogText}, so a
 * token cannot reach a log line through a message, whatever wrote it.
 */
export function redactingLogMethod(
  this: unknown,
  args: unknown[],
  method: (...a: unknown[]) => void
): void {
  method.apply(
    this,
    args.map((a) => (typeof a === 'string' ? redactLogText(a) : a))
  );
}

interface SerializableRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remotePort?: number } | null;
}

/**
 * Fastify's default `req` log serializer, with the URL redacted. Same fields,
 * so log queries written against the default keep working.
 */
export function redactedRequestSerializer(req: SerializableRequest) {
  const version = req.headers?.['accept-version'];
  return {
    host: req.host,
    method: req.method,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
    url: redactRequestUrl(req.url),
    version: Array.isArray(version) ? version.join(', ') : version,
  };
}
