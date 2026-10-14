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

/** Path segments under the prefix that name a route, not a token. */
const NAMED_WEBHOOK_ROUTES: ReadonlySet<string> = new Set([
  'access',
  'ci',
  // Event endpoints: the id in the path names the endpoint, it is not a credential (the
  // endpoint's secret is), so it stays readable in the log.
  'events',
  'git',
  'jira',
  'slack',
]);

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
 * Collapse repeated slashes and resolve `.` and `..` segments, as an HTTP client or the tracing
 * instrumentation would. A path the router 404s (`/api/v1/webhooks//<token>`,
 * `/api/v1/x/../webhooks/<token>`) is still logged and traced, so it is matched in this form.
 */
function normalisePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const lead = path.startsWith('/') ? '/' : '';
  return `${lead}${out.join('/')}${path.endsWith('/') && out.length > 0 ? '/' : ''}`;
}

/**
 * `url` with a webhook token in its path replaced by `[redacted]`: the segment after any
 * `webhooks` segment, unless it names a route. The path is percent-decoded and normalised first,
 * and when something is redacted that form is returned — an encoded or un-normalised spelling of
 * the token is as much a credential as the plain one. The query string is kept; a path with no
 * token is returned unchanged.
 */
export function redactRequestUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const rest = cut === -1 ? '' : url.slice(cut);
  if (!/webhooks/i.test(decodePath(path))) {
    return url;
  }
  const segments = normalisePath(decodePath(path)).split('/');
  let redacted = false;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = segments[i + 1] as string;
    if (
      (segments[i] as string).toLowerCase() === 'webhooks' &&
      next.length > 0 &&
      !NAMED_WEBHOOK_ROUTES.has(next.toLowerCase())
    ) {
      segments[i + 1] = REDACTED_SEGMENT;
      redacted = true;
    }
  }
  return redacted ? `${segments.join('/')}${rest}` : url;
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
