/**
 * Resolver-aware half of the SSRF guard.
 *
 * `ssrfGuard.ts` reads the URL's host TEXT, so a public name that resolves to an
 * internal address (`10.1.1.17.nip.io`, a rebinding name) passes it. This module
 * closes that gap at connection time:
 *
 * - the hostname is resolved once, EVERY returned address is classified with the
 *   same rules as the text check, and the request is refused if any one is
 *   refused (no "pick a good one" — a name that answers with a private address
 *   at all is not trusted);
 * - the TCP connection is made to an address from that checked set, because the
 *   check lives in the dispatcher's `connect.lookup`: the check and the connect
 *   share one resolution, so a second, different answer cannot be used;
 * - TLS SNI and the Host header stay the hostname, so certificate validation is
 *   unaffected;
 * - a DNS failure or timeout refuses (fail closed) with a fixed message.
 *
 * Private (RFC 1918, CGNAT, ULA) addresses are allowed only with `allowPrivate`.
 * Loopback, link-local, unspecified, multicast/reserved and cloud-metadata
 * addresses are refused regardless.
 *
 * Limits: with a process-wide proxy (`NODE_USE_ENV_PROXY`, `--use-env-proxy`) the proxy performs the
 * final resolution, so the target host is checked up front but the connection
 * cannot be pinned. A literal IP is classified directly.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { checkProbeUrl } from './ssrfGuard.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injected so tests need no network. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface GuardOptions {
  /** Waives the refusal for private-network addresses only. */
  allowPrivate?: boolean;
  resolver?: HostResolver;
  /** Wall-clock bound on the resolution. Default 5 s. */
  dnsTimeoutMs?: number;
  /**
   * Replaces the address classifier. Tests only, injected by the caller — never read from the
   * environment — so a local server on 127.0.0.1 can stand in for a "public" host.
   */
  classify?: (address: string, allowPrivate: boolean) => AddressVerdict;
}

export const SSRF_BLOCKED_CODE = 'ESSRF_BLOCKED';

/** Thrown (and surfaced from `fetch`) when the resolved address set is refused. */
export class SsrfBlockedError extends Error {
  readonly code = SSRF_BLOCKED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const DEFAULT_DNS_TIMEOUT_MS = 5000;
const AUTO_SELECT_ATTEMPT_TIMEOUT_MS = 300;

export const defaultResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

function bareHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return (lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower).replace(
    /\.+$/,
    ''
  );
}

export type AddressVerdict = 'ok' | 'private' | 'never';

/**
 * Classifies one resolved (or literal) IP address with the rules of the text
 * guard, which it calls on the address spelled as a URL host, plus multicast and
 * reserved ranges. IPv4-mapped/compatible, NAT64 and 6to4 forms are unwrapped by
 * that guard. An address it cannot parse is `never`.
 */
export function classifyAddress(address: string, allowPrivate = false): AddressVerdict {
  const bare = address.replace(/%.*$/, '').toLowerCase();
  const family = isIP(bare);
  if (family === 0) {
    return 'never';
  }
  let url: string;
  try {
    url = new URL(family === 6 ? `http://[${bare}]/` : `http://${bare}/`).toString();
  } catch {
    return 'never';
  }
  const strict = checkProbeUrl(url);
  if (strict.ok) {
    return 'ok';
  }
  if (!strict.private || /never allowed/.test(strict.reason)) {
    return 'never';
  }
  return allowPrivate ? 'ok' : 'private';
}

function refusal(host: string, verdicts: Set<AddressVerdict>): SsrfBlockedError {
  return verdicts.has('never')
    ? new SsrfBlockedError(
        `host '${host}' resolves to a loopback, link-local, reserved or cloud metadata address and is never allowed`
      )
    : new SsrfBlockedError(`host '${host}' resolves to a private network address`);
}

/**
 * Resolves `hostname` and returns its addresses only when every one passes.
 * Throws {@link SsrfBlockedError} otherwise — including when resolution fails,
 * times out, or returns nothing.
 */
export async function resolveAndCheck(
  hostname: string,
  opts: GuardOptions = {}
): Promise<ResolvedAddress[]> {
  const host = bareHost(hostname);
  if (isIP(host) !== 0) {
    const verdict = (opts.classify ?? classifyAddress)(host, opts.allowPrivate === true);
    if (verdict !== 'ok') {
      throw refusal(host, new Set([verdict]));
    }
    return [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  }
  const resolver = opts.resolver ?? defaultResolver;
  const timeoutMs = opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let addresses: ResolvedAddress[];
  try {
    addresses = await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } catch {
    throw new SsrfBlockedError(`host '${host}' could not be resolved`);
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`host '${host}' could not be resolved`);
  }
  const verdicts = new Set<AddressVerdict>();
  for (const a of addresses) {
    verdicts.add((opts.classify ?? classifyAddress)(a.address, opts.allowPrivate === true));
  }
  verdicts.delete('ok');
  if (verdicts.size > 0) {
    throw refusal(host, verdicts);
  }
  return addresses;
}

type LookupCallback = (
  err: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number
) => void;

/**
 * A `net`/`tls` `lookup` that resolves, checks every address, and hands the
 * socket only checked ones. Plug it into a connector (`connect: { lookup }`) and
 * the check and the connection cannot disagree.
 */
export function makeGuardedLookup(opts: GuardOptions = {}) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean } | LookupCallback,
    callback?: LookupCallback
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const o = typeof options === 'function' ? {} : options;
    resolveAndCheck(hostname, opts).then(
      (addresses) => {
        const want =
          o.family === 4 || o.family === 'IPv4' ? 4 : o.family === 6 || o.family === 'IPv6' ? 6 : 0;
        // IPv4 first, then IPv6: a host with no IPv6 route must not stall or fail on an AAAA
        // record that resolution listed first. The sort is stable within a family.
        const ordered = [...addresses].sort((a, b) => a.family - b.family);
        const usable = want === 0 ? ordered : ordered.filter((a) => a.family === want);
        if (usable.length === 0) {
          cb(new SsrfBlockedError(`host '${bareHost(hostname)}' has no usable address`));
          return;
        }
        if (o.all) {
          cb(null, usable);
        } else {
          cb(null, usable[0].address, usable[0].family);
        }
      },
      (err: Error) => cb(err)
    );
  };
}

/** An undici dispatcher whose every connection goes through {@link makeGuardedLookup}. */
export function guardedDispatcher(opts: GuardOptions = {}): Dispatcher {
  return new Agent({
    // HTTP/1.1 only, as before the guard; ALPN never offers h2.
    allowH2: false,
    connect: {
      // Try the checked addresses in turn (Happy Eyeballs) instead of failing on the first
      // unreachable one, with a short per-attempt wait.
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: AUTO_SELECT_ATTEMPT_TIMEOUT_MS,
      lookup: makeGuardedLookup(opts) as never,
    },
  });
}

const sharedAgents = new Map<boolean, Dispatcher>();
function sharedDispatcher(allowPrivate: boolean): Dispatcher {
  let agent = sharedAgents.get(allowPrivate);
  if (!agent) {
    agent = guardedDispatcher({ allowPrivate });
    sharedAgents.set(allowPrivate, agent);
  }
  return agent;
}

/** True when the process routes fetch through an environment proxy, which resolves the target itself. */
export function usesEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): boolean {
  return (
    /^(1|true)$/i.test(env.NODE_USE_ENV_PROXY ?? '') ||
    execArgv.includes('--use-env-proxy') ||
    /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS ?? '')
  );
}

function causeChainBlocked(err: unknown): SsrfBlockedError | null {
  let current: unknown = err;
  for (let i = 0; i < 5 && current instanceof Error; i++) {
    if (current instanceof SsrfBlockedError) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The fetch that honours the pinned dispatcher. A dispatcher must come from the
 * same undici as the fetch that drives it — the copy bundled in Node speaks a
 * different handler API than the `undici` package, so mixing them fails at
 * connect time — hence the package's own `fetch`, always. A replaced global
 * `fetch` (a test double, an instrumentation wrapper) is deliberately not
 * consulted: it would bypass the dispatcher, and with it the pin. Tests pass
 * `fetchImpl`.
 */
let defaultFetch = undiciFetch as unknown as typeof fetch;

/**
 * Test seam: swaps the fetch that drives the dispatcher, for a suite whose
 * doubles live on `globalThis.fetch`. Refused in production, so a deployed
 * process can only ever use undici's fetch with the pinned dispatcher.
 */
export function setDefaultFetchForTests(fn: typeof fetch): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setDefaultFetchForTests is not available in production');
  }
  defaultFetch = fn;
}

/** The fetch used under an environment proxy: Node's built-in, read at call time. */
function proxiedFetch(): typeof fetch {
  return globalThis.fetch;
}

export interface GuardedFetchOptions extends GuardOptions {
  /** The underlying fetch. Defaults to undici's. */
  fetchImpl?: typeof fetch;
  /** Overrides proxy detection (tests). */
  proxied?: boolean;
}

/**
 * A `fetch` whose connections are resolved, checked and pinned. Use it wherever
 * the URL came from an operator or a user, in place of `fetch`. A refusal throws
 * {@link SsrfBlockedError}. Redirects are the caller's business (`fetchGuarded`
 * follows them by hand, so every hop comes back through here).
 */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): typeof fetch {
  const allowPrivate = opts.allowPrivate === true;
  const proxied = opts.proxied ?? usesEnvProxy();
  const dispatcher = proxied
    ? undefined
    : opts.resolver || opts.dnsTimeoutMs
      ? guardedDispatcher(opts)
      : sharedDispatcher(allowPrivate);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(raw).hostname;
    // A literal IP never reaches `lookup`, so classify it here. Under a proxy the
    // proxy resolves, so the hostname is checked up front instead.
    if (isIP(bareHost(host)) !== 0 || proxied) {
      await resolveAndCheck(host, opts);
    }
    // Under an environment proxy nothing is pinned, and only Node's own fetch is
    // certain to route through the proxy it configured; the undici package's
    // fetch keeps its own global dispatcher, which may connect directly — and
    // fail where direct egress is blocked.
    const doFetch = opts.fetchImpl ?? (proxied ? proxiedFetch() : defaultFetch);
    try {
      return await doFetch(input, (dispatcher ? { ...init, dispatcher } : init) as RequestInit);
    } catch (err) {
      const blocked = causeChainBlocked(err);
      if (blocked) {
        throw blocked;
      }
      throw err;
    }
  }) as typeof fetch;
}

/**
 * A guarded fetch whose private-network waiver applies only to requests whose
 * origin is in `privateOrigins`; every other origin resolves, checks and pins
 * under the strict rules. For a call that talks to one trusted (often internal)
 * host and may be sent elsewhere, such as a redirect to blob storage.
 */
export function createOriginScopedFetch(
  privateOrigins: readonly string[],
  opts: Omit<GuardedFetchOptions, 'allowPrivate'> = {}
): typeof fetch {
  const permissive = createGuardedFetch({ ...opts, allowPrivate: true });
  const strict = createGuardedFetch({ ...opts, allowPrivate: false });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (privateOrigins.includes(new URL(raw).origin) ? permissive : strict)(input, init);
  }) as typeof fetch;
}
