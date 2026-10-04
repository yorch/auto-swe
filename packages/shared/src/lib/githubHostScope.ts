/**
 * Where a PLATFORM credential may go.
 *
 * The platform's credentials — a PAT, an App's installation tokens, and an App
 * JWT (which can mint a token for every installation of the App) — each belong
 * to one GitHub host family and are valid there and nowhere else. They are
 * NEVER sent to another host: an App's id, private key and installations
 * belong to its host, so an installation cannot exist elsewhere, and posting
 * an App JWT to another host would hand it a credential replayable against the
 * real one.
 *
 * Two credential sets exist: the instance's (the `GitHubConfig` singleton,
 * valid on the instance's own host family) and, for any other approved host, the
 * one an admin configured for that host (`GitHubHostCredential`). A repository
 * is reached with the set of the host it lives on; a host with no set is
 * reachable only with a user's own saved token, which is a separate thing,
 * bound to its verified origins.
 *
 * Every place that sends a platform credential to a repository's host asks this
 * module (through `resolvePlatformCredential`, which adds the lookup of the
 * host's set): the worker's `runToken` / `fetchCiLogs` / `repoPermission`, the
 * gateway's check-run lookup, and the shared permission lookup.
 * `resolveGitHubToken` enforces the API-host half of it as a last line, against
 * the set the token is minted from.
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

/**
 * {@link HostScopedRepo} as a credential is minted for it. The installation's
 * host is required, so a caller that loads a repository without it does not
 * compile; an installation whose host is absent fails the mint-time check.
 */
export interface InstallationScopedRepo extends HostScopedRepo {
  /** The `GitHubInstallation.host` of the installation; null only when there is none. */
  installationHost: string | null;
}

export interface HostScopedConfig {
  baseUrl: string;
  apiUrl: string;
  authMode?: string | null;
  appId?: string | null;
  appPrivateKey?: string | null;
}

export type PlatformCredentialScope =
  /** Both hosts are the instance's own: its credential set applies. */
  | 'instance'
  /**
   * Both hosts are one other host that has a credential set of its own: that
   * set applies, and the instance's never does.
   */
  | 'host'
  /** Another host with no credential set: no platform credential applies. */
  | 'mismatch'
  /**
   * The repository's web host and API host are different hosts (a half
   * override): a token minted for one would be sent to the other.
   */
  | 'misconfigured';

/**
 * The host family a repository lives on, judged by its web base (the API base
 * agrees with it unless the repository is `misconfigured`).
 */
export function repoHostFamily(repo: HostScopedRepo, config: HostScopedConfig): string {
  return hostFamily(repo.baseUrl ?? config.baseUrl);
}

/**
 * Where the platform credential may go for `repo`. See the module comment.
 *
 * `configuredHosts` are the host families that have a credential set of their
 * own; omitted, none do and every other host is a `mismatch`.
 */
export function platformCredentialScope(
  repo: HostScopedRepo,
  config: HostScopedConfig,
  configuredHosts: Iterable<string> = []
): PlatformCredentialScope {
  const onInstance =
    (!repo.apiUrl || sameHostFamily(repo.apiUrl, config.apiUrl)) &&
    (!repo.baseUrl || sameHostFamily(repo.baseUrl, config.baseUrl));
  if (onInstance) {
    return 'instance';
  }
  const web = repo.baseUrl ?? config.baseUrl;
  const api = repo.apiUrl ?? config.apiUrl;
  if (!sameHostFamily(web, api)) {
    return 'misconfigured';
  }
  return new Set(configuredHosts).has(hostFamily(web)) ? 'host' : 'mismatch';
}

/**
 * The `GitHubInstallation.host` a repository's installation must carry: empty
 * for the instance's own host, otherwise the repository's host family.
 */
export function installationHostFor(repo: HostScopedRepo, config: HostScopedConfig): string {
  return platformCredentialScope(repo, config, [repoHostFamily(repo, config)]) === 'instance'
    ? ''
    : repoHostFamily(repo, config);
}

/**
 * Whether the repository's installation is recorded for a different host than
 * the repository lives on. A repository with no installation cannot mismatch; one
 * whose installation host is absent fails closed.
 */
export function installationHostMismatch(
  repo: InstallationScopedRepo,
  config: HostScopedConfig
): boolean {
  return (
    Boolean(repo.installationId) && repo.installationHost !== installationHostFor(repo, config)
  );
}

/**
 * Which installation, and at which API host, `repo`'s platform credential comes
 * from: the API host of the credential set the caller resolved (`config` is that
 * set's config), and the repository's installation — which must live on that
 * same host (`GitHubInstallation.host`). A repository with no installation of
 * its own takes the instance singleton's, which a host's set does not have.
 * Callers must have resolved a set for the repository's scope; the
 * `resolveGitHubToken` guard refuses any other host regardless.
 */
export function installationTargetFor(
  repo: HostScopedRepo,
  config: { apiUrl: string }
): { installationId: string | null; apiUrl: string } {
  return { apiUrl: config.apiUrl, installationId: repo.installationId ?? null };
}

/** The API base of a host family when no repository override states one. */
export function defaultApiUrlForHost(host: string): string {
  const hostname = host.toLowerCase().split(':')[0];
  if (hostname === 'github.com') {
    return 'https://api.github.com';
  }
  if (GHE_CLOUD_WEB.test(hostname)) {
    return `https://api.${host}`;
  }
  return `https://${host}/api/v3`;
}
