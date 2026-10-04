import { resolveSetting } from '../../config/index.js';
import { approvedRepositoryHosts } from '../connectionCredential.js';
import { resolvePlatformCredential } from '../githubHostCredential.js';
import { defaultApiUrlForHost, hostFamily } from '../githubHostScope.js';
import { resolveGitHubToken } from '../githubInstallation.js';
import { checkProbeUrl } from '../ssrfGuard.js';
import { resolveGitHubConfig } from '../systemConfig.js';
import { networkError, SkillSourceError } from './errors.js';

/** What a source fetch needs from the outside, injectable for tests. */
export interface SkillSourceDeps {
  fetch: typeof fetch;
  approvedHosts: () => Promise<string[]>;
  /** `skills.import.privateNetworkHosts`: hosts an admin allows on a private address. */
  privateNetworkHosts: () => Promise<string[]>;
  githubConfig: typeof resolveGitHubConfig;
  platformCredential: typeof resolvePlatformCredential;
  githubToken: typeof resolveGitHubToken;
  /** Clock, for the deadline. */
  now?: () => number;
  limits?: Partial<FetchLimits>;
}

export const defaultDeps: SkillSourceDeps = {
  approvedHosts: approvedRepositoryHosts,
  fetch: (...args) => fetch(...args),
  githubConfig: resolveGitHubConfig,
  githubToken: resolveGitHubToken,
  platformCredential: resolvePlatformCredential,
  privateNetworkHosts: () => resolveSetting('skills.import.privateNetworkHosts'),
};

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * What one fetch of a source may spend. The platform token is shared with every
 * workflow, so an import must not be able to drain it: a source costs at most
 * `maxRequests` API calls (counting redirect hops), the whole fetch has a
 * deadline, and it stops as soon as the host reports the remaining budget is
 * under `rateFloor` — scaled down to a fifth of the limit when the limit is
 * small (an anonymous 60/hour read), so that case can still work.
 */
export interface FetchLimits {
  maxRequests: number;
  deadlineMs: number;
  rateFloor: number;
}
export const MAX_API_REQUESTS = 300;
export const FETCH_DEADLINE_MS = 60_000;
export const RATE_LIMIT_FLOOR = 200;
export const DEFAULT_LIMITS: FetchLimits = {
  deadlineMs: FETCH_DEADLINE_MS,
  maxRequests: MAX_API_REQUESTS,
  rateFloor: RATE_LIMIT_FLOOR,
};
const MAX_REDIRECTS = 5;
/** Largest JSON response read: a full recursive tree is the big one. */
const MAX_RESPONSE_BYTES = 12_000_000;

const HOST_RE = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * Whether `host` may be read from at all. github.com is public and needs no
 * approval; every other host must be the instance's own GitHub host or one an
 * admin listed in `github.repositoryHosts` — that setting is the admin's
 * statement that this platform may talk to that host.
 */
export function hostPermitted(host: string, approved: readonly string[]): boolean {
  return host === 'github.com' || approved.some((h) => h.toLowerCase() === host);
}

/** One resolved, vetted way of talking to a source's host. */
export interface SourceAccess {
  host: string;
  /** API base, no trailing slash. */
  apiBase: string;
  /** The platform token for this host, or null for anonymous reads. */
  token: string | null;
  /**
   * The hosts (`host[:port]`) that may be, or resolve to, a private address:
   * the source's own, and only when it is both approved and opted in. Empty
   * otherwise. Everything else faces the full SSRF guard.
   */
  privateHosts: ReadonlySet<string>;
  /** Spent so far by this fetch; shared by every request made with this access. */
  budget: { requests: number; startedAt: number; limits: FetchLimits };
  deps: SkillSourceDeps;
}

/** The SSRF check for one URL: https only, no userinfo, private addresses only for an opted-in host. */
function assertSafeUrl(raw: string, privateHosts: ReadonlySet<string>): URL {
  let host = '';
  try {
    host = new URL(raw).host.toLowerCase();
  } catch {
    throw new SkillSourceError('HOST_BLOCKED');
  }
  const safety = checkProbeUrl(raw, { allowPrivate: privateHosts.has(host) });
  if (!safety.ok || safety.url.protocol !== 'https:') {
    throw new SkillSourceError('HOST_BLOCKED');
  }
  if (safety.url.username || safety.url.password) {
    throw new SkillSourceError('HOST_BLOCKED');
  }
  return safety.url;
}

/**
 * Vet `host` and work out what credential, if any, it gets — BEFORE any request.
 *
 * Only the platform credential is ever used (never a user's personal token), it
 * is resolved through `resolvePlatformCredential`, so the instance's token goes
 * to the instance's host and a host's own credential to that host and nowhere
 * else, and a host with none is read anonymously.
 */
export async function resolveAccess(
  rawHost: string,
  deps: SkillSourceDeps = defaultDeps
): Promise<SourceAccess> {
  const host = rawHost.toLowerCase();
  if (!HOST_RE.test(host)) {
    throw new SkillSourceError('INVALID_SOURCE');
  }
  const approved = (await deps.approvedHosts()).map((h) => h.toLowerCase());
  if (!hostPermitted(host, approved)) {
    throw new SkillSourceError('HOST_NOT_APPROVED');
  }
  const config = await deps.githubConfig();
  const apiBase = (
    hostFamily(config.baseUrl) === hostFamily(`https://${host}`)
      ? config.apiUrl
      : defaultApiUrlForHost(host)
  ).replace(/\/+$/, '');
  // Private addresses need BOTH the repository-host approval (checked above, and
  // not satisfied by github.com's standing exemption) and the explicit opt-in.
  const optedIn = (await deps.privateNetworkHosts()).map((h) => h.toLowerCase());
  const privateHosts = new Set(
    approved.includes(host) && optedIn.includes(host)
      ? [host, new URL(apiBase).host.toLowerCase()]
      : []
  );
  assertSafeUrl(`https://${host}`, privateHosts);
  assertSafeUrl(apiBase, privateHosts);

  let token: string | null = null;
  const credential = await deps.platformCredential(
    // A skill source is read through no GitHub App installation, so there is
    // no installation host to check against.
    { apiUrl: apiBase, baseUrl: `https://${host}`, installationHost: null },
    config
  );
  if (credential.scope === 'instance' || credential.scope === 'host') {
    try {
      token = await deps.githubToken(credential.config, { apiUrl: apiBase });
    } catch {
      // No usable token (an App with no installation, a failed mint): read anonymously.
      token = null;
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const startedAt = (deps.now ?? Date.now)();
  return { apiBase, budget: { limits, requests: 0, startedAt }, deps, host, privateHosts, token };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        throw new SkillSourceError('BAD_RESPONSE');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET one API path and parse the JSON. Redirects are followed by hand: every
 * hop is re-vetted (https, the host policy, the SSRF guard) and the token is
 * attached only while the hop stays on the API origin it was minted for.
 */
export async function apiGet(access: SourceAccess, path: string): Promise<unknown> {
  const origin = new URL(access.apiBase).origin;
  let current = `${access.apiBase}${path}`;
  for (let hop = 0; ; hop++) {
    const url = assertSafeUrl(current, access.privateHosts);
    if (
      hop > 0 &&
      url.origin !== origin &&
      !hostPermitted(url.host.toLowerCase(), await access.deps.approvedHosts())
    ) {
      throw new SkillSourceError('REDIRECT_BLOCKED');
    }
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'auto-swe-skill-import',
    };
    if (access.token && url.origin === origin) {
      headers.Authorization = `Bearer ${access.token}`;
    }
    const { budget } = access;
    const left = budget.startedAt + budget.limits.deadlineMs - (access.deps.now ?? Date.now)();
    if (left <= 0) {
      throw new SkillSourceError('TIMEOUT');
    }
    if (++budget.requests > budget.limits.maxRequests) {
      throw new SkillSourceError('LIMIT_REQUESTS');
    }
    let res: Response;
    try {
      res = await access.deps.fetch(url.toString(), {
        headers,
        redirect: 'manual',
        // Per request, and for the whole fetch: the body read is covered too.
        signal: AbortSignal.any([
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          AbortSignal.timeout(left),
        ]),
      });
    } catch (err) {
      throw networkError(err);
    }
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      assertRateBudget(res, budget.limits.rateFloor);
    }
    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) {
        throw new SkillSourceError('TOO_MANY_REDIRECTS');
      }
      const location = res.headers.get('location');
      if (!location) {
        throw new SkillSourceError('BAD_RESPONSE');
      }
      try {
        current = new URL(location, url).toString();
      } catch {
        throw new SkillSourceError('BAD_RESPONSE');
      }
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw statusError(res);
    }
    try {
      return JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES));
    } catch (err) {
      if (err instanceof SkillSourceError) {
        throw err;
      }
      // The deadline or the request timeout fired while the body was being read.
      const name = (err as { name?: unknown } | null)?.name;
      throw new SkillSourceError(
        name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'BAD_RESPONSE'
      );
    }
  }
}

/** Stop while the host still has headroom for everyone else's calls. */
function assertRateBudget(res: Response, floor: number): void {
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Number.NaN);
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? Number.NaN);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) {
    return;
  }
  if (remaining < Math.min(floor, Math.ceil(limit * 0.2))) {
    throw new SkillSourceError('RATE_LIMIT_LOW');
  }
}

function statusError(res: Response): SkillSourceError {
  if (res.status === 404 || res.status === 422) {
    return new SkillSourceError('NOT_FOUND');
  }
  if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
    return new SkillSourceError('RATE_LIMITED');
  }
  if (res.status === 401 || res.status === 403) {
    return new SkillSourceError('UNAUTHORIZED');
  }
  return new SkillSourceError('HTTP_ERROR', `HTTP ${res.status}`);
}
