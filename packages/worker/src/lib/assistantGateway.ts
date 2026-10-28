import { resolveGatewayInternalUrl } from '@auto-swe/shared/lib/systemConfig';

/**
 * How the in-app assistant's tools reach the platform: the gateway's own `/api/v1` routes, over
 * HTTP, with the assistant token the gateway minted for this turn. The token carries the user's
 * identity and the conversation, so every route's role gate, visibility filter and audit apply to
 * the assistant as they do to the user, and `assistantPolicy.ts` decides which routes it may call
 * at all. The tools never read the database themselves (`docs/history/in-app-assistant.md` D1, D6).
 */

export interface GatewayResponse {
  status: number;
  /** The parsed JSON body; the raw text when it was not JSON; undefined when there was none. */
  body: unknown;
  /** Set when the body was longer than {@link MAX_RESPONSE_CHARS} and was cut. */
  truncated?: boolean;
}

export interface AssistantGateway {
  /** One GET to an `/api/v1` route, as the user. `path` is the route path, with no query. */
  get(path: string, query?: Readonly<Record<string, string>>): Promise<GatewayResponse>;
}

/** Longest response body read back; more is cut, so one call cannot fill the model's context. */
export const MAX_RESPONSE_CHARS = 200_000;

const REQUEST_TIMEOUT_MS = 20_000;

/** Thrown for a path the tools may not send, before any request is made. */
export class AssistantPathError extends Error {}

/**
 * The URL for `path` under the gateway, or a throw when `path` is not a plain `/api/v1/...` path.
 * The check is on the parsed URL, so `..` segments, encoded slashes, a scheme or a host in `path`
 * cannot send the token anywhere but the gateway's API.
 */
export function gatewayUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> = {}
): URL {
  if (!path.startsWith('/api/v1/') || /[?#\\]|%2f|%5c|%2e/i.test(path)) {
    throw new AssistantPathError('path must be an /api/v1/ route path, without a query string');
  }
  const base = new URL(baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
  const apiRoot = `${base.pathname.replace(/\/+$/, '')}/api/v1/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(apiRoot)) {
    throw new AssistantPathError('path must stay under /api/v1/');
  }
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * A gateway client bound to one token. The base URL is the operator's `API_INTERNAL_URL`, never
 * anything the model says, and redirects are refused so the token is sent to that origin only.
 */
export function createAssistantGateway(
  token: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
): AssistantGateway {
  const baseUrl = options.baseUrl ?? resolveGatewayInternalUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async get(path, query) {
      const url = gatewayUrl(baseUrl, path, query);
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      const truncated = text.length > MAX_RESPONSE_CHARS;
      const kept = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
      let body: unknown;
      if (kept !== '') {
        try {
          body = JSON.parse(kept);
        } catch {
          body = kept;
        }
      }
      return truncated ? { body, status: res.status, truncated } : { body, status: res.status };
    },
  };
}
