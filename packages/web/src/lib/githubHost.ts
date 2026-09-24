/**
 * `Connection.githubUrl` / `githubApiUrl` are HOST overrides — the web base
 * (`https://ghe.example.com`) and API base (`https://ghe.example.com/api/v3`)
 * of a GitHub Enterprise install — not links to one repository. They are left
 * null for github.com, where the worker's defaults already apply.
 */

const PUBLIC_GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'api.github.com']);

export interface GitHubHostOverrides {
  githubUrl?: string;
  githubApiUrl?: string;
}

/**
 * Derive the host overrides for a repository returned by the GitHub listing
 * (`html_url` = `<web base>/<org>/<repo>`, `url` = `<api base>/repos/<org>/<repo>`).
 * Returns `{}` for github.com and for anything that does not parse, so a
 * per-repository URL is never stored in a host column.
 */
export function hostOverridesFromRepoUrls(htmlUrl: string, apiUrl: string): GitHubHostOverrides {
  let html: URL;
  try {
    html = new URL(htmlUrl);
  } catch {
    return {};
  }
  if (PUBLIC_GITHUB_HOSTS.has(html.hostname.toLowerCase())) {
    return {};
  }
  // html_url is `<web base>/<org>/<repo>`; the web base keeps any path prefix a
  // GHE install is served under (`https://corp.example/github`), so strip only
  // the trailing org/repo segments rather than taking the bare origin.
  const segments = html.pathname.replace(/\/+$/, '').split('/');
  const prefix = segments.length >= 3 ? segments.slice(0, -2).join('/') : '';
  const overrides: GitHubHostOverrides = { githubUrl: `${html.origin}${prefix}` };
  try {
    const api = new URL(apiUrl);
    const idx = api.pathname.lastIndexOf('/repos/');
    if (idx >= 0) {
      const base = `${api.origin}${api.pathname.slice(0, idx)}`;
      overrides.githubApiUrl = base.replace(/\/+$/, '');
    }
  } catch {
    // No API base — the gateway derives one from the web base.
  }
  return overrides;
}

/**
 * Web base for building links to a repository. Tolerates a stored value that
 * is the repository's own URL (the import flow used to store `html_url` in the
 * host column) by stripping a trailing `/<org>/<repo>`; a GHE base with a path
 * prefix is kept as-is.
 */
export function githubWebBase(
  githubUrl: string | null | undefined,
  org?: string | null,
  repo?: string | null
): string {
  if (!githubUrl) {
    return 'https://github.com';
  }
  let base = githubUrl.replace(/\/+$/, '');
  if (org && repo) {
    const suffix = `/${org}/${repo}`.toLowerCase();
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
    }
  }
  return base;
}
