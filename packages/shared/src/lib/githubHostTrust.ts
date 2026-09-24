/**
 * Which hosts a GitHub credential may be sent to.
 *
 * A repository's `githubUrl` / `githubApiUrl` columns are HOST overrides for a
 * GitHub Enterprise install: the web base (`https://ghe.example.com`) and the
 * API base (`https://ghe.example.com/api/v3`). Every call that reaches GitHub
 * for that repository — permission lookups, App installation-token minting,
 * Octokit, the authenticated clone URL — sends the platform credential to the
 * host the override names. An override is therefore a credential destination,
 * and one pointed at an arbitrary host hands that host a token that can read
 * and push every repository the credential covers.
 *
 * So an override is accepted only when it names a host the deployment already
 * trusts: public GitHub, or the GitHub instance configured at
 * `/studio/integrations`. The same check runs at write time (the repository
 * routes) and again at every point of use, so a row written before the check
 * existed, or by any path that skipped it, still cannot receive a token.
 */

/** Public GitHub's web and API origins. */
export const PUBLIC_GITHUB_ORIGINS: readonly string[] = [
  'https://github.com',
  'https://api.github.com',
];

/** The path a GitHub Enterprise API base carries after its origin. */
const GHE_API_PATH = '/api/v3';

/** The instance-level URLs from `resolveGitHubConfig()`. */
export interface GitHubHostConfig {
  baseUrl: string;
  apiUrl: string;
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Origins of the configured GitHub instance (web and API base). A malformed
 * configured URL contributes nothing.
 */
export function configuredGitHubOrigins(ghConfig: GitHubHostConfig): string[] {
  const origins: string[] = [];
  for (const raw of [ghConfig.baseUrl, ghConfig.apiUrl]) {
    const origin = originOf(raw);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

/** Every origin a repository host override may name: configured + public GitHub. */
export function trustedGitHubOrigins(ghConfig: GitHubHostConfig): string[] {
  const origins = configuredGitHubOrigins(ghConfig);
  for (const origin of PUBLIC_GITHUB_ORIGINS) {
    if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

export type HostOverrideKind = 'web' | 'api';

export type HostOverrideCheck = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Validate and normalise a repository host override.
 *
 * Accepts a bare origin on a trusted host, plus — for an API base only — the
 * GitHub Enterprise `/api/v3` path. Rejects credentials in the URL, a query or
 * fragment, and any other path: a per-repository URL (`…/org/repo`) stored in a
 * host column breaks every URL built from it, and an arbitrary path is a way to
 * aim a credentialed request at an endpoint of the host's choosing.
 *
 * The returned value is normalised (lowercase origin, no trailing slash) so
 * two spellings of the same host compare equal.
 */
export function checkGitHubHostOverride(
  kind: HostOverrideKind,
  raw: string,
  ghConfig: GitHubHostConfig
): HostOverrideCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'is not a valid URL' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'must not contain credentials' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'must not contain a query or fragment' };
  }
  if (!trustedGitHubOrigins(ghConfig).includes(url.origin)) {
    return {
      ok: false,
      reason: `must be github.com or the GitHub instance configured at /studio/integrations (got ${url.origin})`,
    };
  }
  const path = url.pathname.replace(/\/+$/, '');
  const pathAllowed = path === '' || (kind === 'api' && path === GHE_API_PATH);
  if (!pathAllowed) {
    return {
      ok: false,
      reason:
        kind === 'api'
          ? 'must be a host (optionally with /api/v3), not a repository URL'
          : 'must be a host, not a repository URL',
    };
  }
  return { ok: true, value: `${url.origin}${path}` };
}

/**
 * Whether a credential may be sent to `raw`, a stored host override — the
 * point-of-use twin of {@link checkGitHubHostOverride}.
 *
 * Deliberately checks only what decides where the credential goes: the URL
 * parses, carries no userinfo, and its origin is trusted. The stricter path
 * rules belong to the write path; failing a clone over a path shape here would
 * break a row without protecting anything.
 */
export function isTrustedGitHubHost(raw: string, ghConfig: GitHubHostConfig): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) {
    return false;
  }
  return trustedGitHubOrigins(ghConfig).includes(url.origin);
}

/** Thrown when a stored host override names a host no credential may reach. */
export class UntrustedGitHubHostError extends Error {
  constructor(kind: HostOverrideKind, raw: string) {
    super(
      `Refusing to send the GitHub credential to untrusted ${kind === 'api' ? 'API' : 'web'} ` +
        `host override '${raw}'. Fix the repository's GitHub URL settings.`
    );
    this.name = 'UntrustedGitHubHostError';
  }
}
