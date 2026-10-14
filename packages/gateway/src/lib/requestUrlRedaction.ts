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
 * `url` with a webhook token in its path replaced by `[redacted]`. The query
 * string is kept; anything not under the webhook prefix is returned unchanged.
 * Matching is case-insensitive on the prefix because a router that treats the
 * path case-insensitively would still have logged the token verbatim.
 */
export function redactRequestUrl(url: string): string {
  const lower = url.toLowerCase();
  const at = lower.indexOf(WEBHOOK_PREFIX);
  if (at === -1) {
    return url;
  }
  const start = at + WEBHOOK_PREFIX.length;
  let end = start;
  while (end < url.length && url[end] !== '/' && url[end] !== '?' && url[end] !== '#') {
    end++;
  }
  const segment = url.slice(start, end);
  if (segment.length === 0 || NAMED_WEBHOOK_ROUTES.has(segment.toLowerCase())) {
    return url;
  }
  return `${url.slice(0, start)}${REDACTED_SEGMENT}${url.slice(end)}`;
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
