import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';

const PROFILE_FETCH_TIMEOUT_MS = 5_000;
const GITHUB_COM_HOST = 'github.com';
const GITHUB_COM_API = 'https://api.github.com';

export type GhesUserInfo = {
  id: string;
  name: string;
  email: string;
  emailVerified: true;
  image?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// `redirect: 'error'` keeps the bearer token on the one host the admin configured.
async function getJson(api: string, path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${api}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'auto-swe/1.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${path} answered ${res.status}`);
  }
  return res.json();
}

function refuse(host: string, reason: string): null {
  console.warn(`[better-auth] GitHub Enterprise sign-in refused for ${host}: ${reason}`);
  return null;
}

/**
 * Resolve the signed-in GitHub Enterprise user into a better-auth profile.
 *
 * Returns null — which better-auth turns into a refused sign-in — unless the
 * account has a primary, verified email. The public `email` on `/user` is never
 * used: it carries no verification flag, and `github` is a trusted provider for
 * account linking, so an unverified address could link onto someone else's user.
 *
 * The id is prefixed with the host. Accounts are keyed `(providerId, accountId)`
 * and github.com and GHE both issue small numeric ids, so a bare id could match
 * a user's earlier github.com account.
 */
export async function fetchGhesUserInfo(
  accessToken: string,
  apiUrl: string,
  host: string
): Promise<GhesUserInfo | null> {
  const api = apiUrl.replace(/\/$/, '');
  const hostname = host.toLowerCase();
  try {
    const [profile, emails] = await Promise.all([
      getJson(api, '/user', accessToken),
      getJson(api, '/user/emails', accessToken),
    ]);
    if (!isRecord(profile) || !Array.isArray(emails)) {
      return refuse(hostname, 'unexpected profile or email response');
    }
    const primary = emails.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.primary === true &&
        entry.verified === true &&
        typeof entry.email === 'string'
    );
    if (!primary) {
      return refuse(hostname, 'the account has no primary verified email');
    }
    const accountId = profile.id;
    if (typeof accountId !== 'number' || !Number.isInteger(accountId)) {
      return refuse(hostname, 'the profile has no integer id');
    }
    const email = primary.email as string;
    const login = typeof profile.login === 'string' ? profile.login : undefined;
    return {
      email,
      emailVerified: true,
      id: `${hostname}:${accountId}`,
      image: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined,
      name: typeof profile.name === 'string' && profile.name ? profile.name : (login ?? email),
    };
  } catch (err) {
    return refuse(hostname, err instanceof Error ? err.message : 'request failed');
  }
}

export type GithubSignIn =
  | { mode: 'none' }
  | { mode: 'builtin'; clientId: string; clientSecret: string }
  | { mode: 'ghe'; config: GenericOAuthConfig; apiUrl: string };

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Origin plus path, so any credentials, query or fragment in the admin's value are dropped.
function rootOf(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function isGithubDotCom(url: URL): boolean {
  return url.hostname.replace(/\.$/, '') === GITHUB_COM_HOST;
}

// The saved API URL defaults to api.github.com; an admin who only filled in a GHE Base URL means
// that instance's /api/v3. The one place this is decided, so no caller derives its own.
function apiRootFor(base: URL, api: URL): string {
  const apiRoot = rootOf(api);
  return apiRoot === GITHUB_COM_API && !isGithubDotCom(base) ? `${rootOf(base)}/api/v3` : apiRoot;
}

/**
 * The API root to use for GitHub calls made with a user's own access token, or null when either
 * saved URL is invalid. Matches the API URL GHE sign-in resolved.
 */
export function resolveGithubApiUrl(baseUrl: string, apiUrl: string): string | null {
  const base = parseHttpUrl(baseUrl);
  const api = parseHttpUrl(apiUrl);
  return base && api ? apiRootFor(base, api) : null;
}

/**
 * Decide how "Continue with GitHub" is wired from the saved GitHub config.
 *
 * better-auth's built-in `github` provider is fixed to github.com, so a Base URL on
 * any other host is served by a generic-OAuth provider registered under the same id.
 * Reusing the id keeps the callback URL, the account rows and every `'github'` check.
 *
 * Never throws: a bad URL disables GitHub sign-in with a logged reason, because this
 * runs at gateway start and must not stop it booting.
 */
export function resolveGithubSignIn(input: {
  clientId: string | null;
  clientSecret: string | null;
  baseUrl: string;
  apiUrl: string;
}): GithubSignIn {
  const { clientId, clientSecret } = input;
  if (!clientId || !clientSecret) {
    return { mode: 'none' };
  }

  const base = parseHttpUrl(input.baseUrl);
  if (!base) {
    console.warn('[better-auth] GitHub sign-in disabled: the Base URL is not a valid http(s) URL');
    return { mode: 'none' };
  }
  if (isGithubDotCom(base)) {
    return { clientId, clientSecret, mode: 'builtin' };
  }

  const api = parseHttpUrl(input.apiUrl);
  if (!api) {
    console.warn('[better-auth] GitHub sign-in disabled: the API URL is not a valid http(s) URL');
    return { mode: 'none' };
  }

  if (base.protocol === 'http:' || api.protocol === 'http:') {
    console.warn(
      '[better-auth] GitHub Enterprise sign-in is configured over plain http: the client secret, authorization code and access token cross the network unencrypted'
    );
  }

  const baseRoot = rootOf(base);
  const apiRoot = apiRootFor(base, api);

  return {
    apiUrl: apiRoot,
    config: {
      authorizationUrl: `${baseRoot}/login/oauth/authorize`,
      clientId,
      clientSecret,
      getUserInfo: async (tokens) =>
        tokens.accessToken ? fetchGhesUserInfo(tokens.accessToken, apiRoot, base.host) : null,
      pkce: false,
      providerId: 'github',
      scopes: ['read:user', 'user:email'],
      tokenUrl: `${baseRoot}/login/oauth/access_token`,
    },
    mode: 'ghe',
  };
}
