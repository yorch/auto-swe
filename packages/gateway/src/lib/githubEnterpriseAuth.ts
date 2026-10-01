const PROFILE_FETCH_TIMEOUT_MS = 5_000;

export interface GhesUserInfo {
  id: string;
  name: string;
  email: string;
  emailVerified: true;
  image?: string;
}

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
