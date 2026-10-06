/**
 * `fetch` that follows redirects by hand so every hop is checked.
 *
 * A transparent redirect would carry a request to a host nobody validated, and
 * would let a credential travel with it. Here each hop must pass `check`, the
 * hop count is capped, and the credential headers are sent only while the hop
 * is on `credentialOrigin` — a hop elsewhere forwards only an allowlist of
 * benign headers, and only for GET/HEAD. A 307/308
 * keeps the method and body; any other redirect of a non-GET/HEAD request is
 * refused rather than rewritten.
 */
export const MAX_GUARDED_REDIRECTS = 3;

// On a hop to another origin only these request headers are forwarded. An
// allowlist, because credentials come in many spellings (Authorization, cookies,
// API-key headers) and any header not named here could be one.
const CROSS_ORIGIN_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'user-agent',
  'x-github-api-version',
];

export class RedirectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectRefusedError';
  }
}

function headerRecord(init: RequestInit['headers']): Record<string, string> {
  if (!init) {
    return {};
  }
  if (init instanceof Headers || Array.isArray(init)) {
    return Object.fromEntries(new Headers(init));
  }
  return { ...init } as Record<string, string>;
}

export interface GuardedFetchOptions {
  /** Returns true when the URL may be requested. Run on the first URL and on every hop. */
  check: (url: URL) => boolean;
  /** Credential headers are sent only to this origin; elsewhere only an allowlist of benign headers is. */
  credentialOrigin?: string;
  maxHops?: number;
  /** Required: there is no bare-`fetch` default, so a caller always names a resolve-and-pin fetch. */
  fetchImpl: typeof fetch;
}

export async function fetchGuarded(
  url: string,
  init: RequestInit,
  opts: GuardedFetchOptions
): Promise<Response> {
  const doFetch = opts.fetchImpl;
  const maxHops = opts.maxHops ?? MAX_GUARDED_REDIRECTS;
  const baseHeaders = headerRecord(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  let current = new URL(url);
  const startOrigin = current.origin;
  for (let hop = 0; ; hop++) {
    if (!opts.check(current)) {
      throw new RedirectRefusedError(
        hop === 0 ? 'request target refused' : 'redirect target refused'
      );
    }
    const headers = { ...baseHeaders };
    if (hop > 0 && current.origin !== startOrigin && method !== 'GET' && method !== 'HEAD') {
      throw new RedirectRefusedError('redirect to another origin refused for a write');
    }
    if (opts.credentialOrigin !== current.origin) {
      for (const name of Object.keys(headers)) {
        if (!CROSS_ORIGIN_HEADERS.includes(name.toLowerCase())) {
          delete headers[name];
        }
      }
    }
    const res = await doFetch(current.toString(), {
      ...init,
      headers,
      method,
      redirect: 'manual',
    });
    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    await res.body?.cancel().catch(() => {});
    if (hop >= maxHops) {
      throw new RedirectRefusedError('too many redirects');
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new RedirectRefusedError('redirect without a Location header');
    }
    const keepsMethod = res.status === 307 || res.status === 308;
    if (!keepsMethod && method !== 'GET' && method !== 'HEAD') {
      throw new RedirectRefusedError('redirect would change the request method');
    }
    try {
      current = new URL(location, current);
    } catch {
      throw new RedirectRefusedError('redirect with an invalid Location header');
    }
  }
}
