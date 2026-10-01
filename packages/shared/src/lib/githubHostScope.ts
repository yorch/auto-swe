/**
 * Where a PLATFORM credential may go.
 *
 * The platform's credentials — the instance PAT, the singleton App's
 * installation token, and an App JWT (which can mint a token for every
 * installation of the App) — are valid on the instance's own GitHub host and
 * nowhere else. They are NEVER sent to another host: the App's id, private key
 * and every installation of it belong to the instance's host, so an installation
 * cannot exist elsewhere, and posting an App JWT to another host would hand it a
 * credential replayable against the real one. A repository on another host is
 * reachable only with a user's own saved token, which is a separate thing, bound
 * to its verified origins.
 *
 * Every place that sends a platform credential to a repository's host asks this
 * module, so the rule has one definition: the worker's `runToken` /
 * `fetchCiLogs` / `repoPermission`, the gateway's check-run lookup, and the
 * shared permission lookup. `resolveGitHubToken` enforces the API-host half of
 * it as a last line.
 */

/**
 * `host[:port]` of a URL, lowercased; the lowercased string when it does not
 * parse (so two spellings of one bad value still compare equal).
 */
export function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const GHE_CLOUD_API = /^api\.([^.]+\.ghe\.com)$/;
const GHE_CLOUD_WEB = /^[^.]+\.ghe\.com$/;

/**
 * Hostnames that send github.com-style deliveries: github.com and GitHub
 * Enterprise Cloud with data residency (`<tenant>.ghe.com`), each with its API
 * host. Neither sends `X-GitHub-Enterprise-Host`.
 */
export function isDotcomStyleHost(host: string): boolean {
  const hostname = host.toLowerCase().split(':')[0];
  return (
    hostname === 'github.com' ||
    hostname === 'api.github.com' ||
    GHE_CLOUD_WEB.test(hostname) ||
    GHE_CLOUD_API.test(hostname)
  );
}

/**
 * The host a URL belongs to, with a hosted GitHub's web and API hosts folded
 * together: `github.com` ≡ `api.github.com`, `<t>.ghe.com` ≡ `api.<t>.ghe.com`.
 * Those pairs are one host, served on two names; a GitHub Enterprise Server
 * keeps both on the same hostname already.
 */
export function hostFamily(url: string): string {
  const key = hostKey(url);
  if (key === 'api.github.com') {
    return 'github.com';
  }
  return key.replace(GHE_CLOUD_API, '$1');
}

/** Whether two URLs are on the same host (family). */
export function sameHostFamily(a: string, b: string): boolean {
  return hostFamily(a) === hostFamily(b);
}

/** The repository columns the rule reads, under neutral names. */
export interface HostScopedRepo {
  /** Per-repo API base override; null/undefined → the instance's. */
  apiUrl?: string | null;
  /** Per-repo web base override; null/undefined → the instance's. */
  baseUrl?: string | null;
  /** The repository's own GitHub App installation, if any. */
  installationId?: string | null;
}

export interface HostScopedConfig {
  baseUrl: string;
  apiUrl: string;
  authMode?: string | null;
  appId?: string | null;
  appPrivateKey?: string | null;
}

/** Whether the instance would use the GitHub App (not the PAT). */
export function isAppMode(config: HostScopedConfig): boolean {
  const mode = config.authMode ?? 'auto';
  return mode === 'app' || (mode === 'auto' && Boolean(config.appId && config.appPrivateKey));
}

export type PlatformCredentialScope =
  /** Both hosts are the instance's own: its credential applies. */
  | 'instance'
  /** Another host: no platform credential applies. */
  | 'mismatch'
  /**
   * The repository's web host and API host are different hosts (a half
   * override): a token minted for one would be sent to the other.
   */
  | 'misconfigured';

/** Where the platform credential may go for `repo`. See the module comment. */
export function platformCredentialScope(
  repo: HostScopedRepo,
  config: HostScopedConfig
): PlatformCredentialScope {
  const onInstance =
    (!repo.apiUrl || sameHostFamily(repo.apiUrl, config.apiUrl)) &&
    (!repo.baseUrl || sameHostFamily(repo.baseUrl, config.baseUrl));
  if (onInstance) {
    return 'instance';
  }
  const web = repo.baseUrl ?? config.baseUrl;
  const api = repo.apiUrl ?? config.apiUrl;
  return sameHostFamily(web, api) ? 'mismatch' : 'misconfigured';
}

/**
 * Which installation, and at which API host, `repo`'s platform credential comes
 * from. Always the instance's API host — installations live only there. A
 * repository with no installation of its own takes the singleton's. Callers
 * must have checked {@link platformCredentialScope} is 'instance'; the
 * `resolveGitHubToken` guard refuses any other host regardless.
 */
export function installationTargetFor(
  repo: HostScopedRepo,
  config: { apiUrl: string }
): { installationId: string | null; apiUrl: string } {
  return { apiUrl: config.apiUrl, installationId: repo.installationId ?? null };
}

/**
 * Whether the instance's API host is github.com's — the only place a platform
 * credential may be sent when asking about a github.com account.
 */
export function instanceIsGithubDotCom(config: { apiUrl: string }): boolean {
  return hostFamily(config.apiUrl) === 'github.com';
}
