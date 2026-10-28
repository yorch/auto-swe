/**
 * GitHub App installation tokens, for one or many installations.
 *
 * This used to live twice — once in the gateway, once in the worker — as two
 * copies that had already drifted apart in naming and error text. Both held a
 * *single* cached token in a module-level slot, which was correct only while
 * there was exactly one installation: with two, alternating calls evict each
 * other's token and every request pays a fresh round-trip to GitHub.
 *
 * Multiple installations are how a deployment reaches repositories across more
 * than one GitHub organization, so the cache is keyed per installation, and the
 * logic lives in one place rather than being fixed twice and re-diverging.
 *
 * The packages keep their own thin wrappers: the worker turns a missing
 * credential into a non-retryable Temporal failure, and the gateway turns it
 * into a 503. Only the credential mechanics are shared.
 */
import { createHash, createSign } from 'node:crypto';
import { hostFamily } from './githubHostScope.js';
import { fetchGuarded } from './guardedFetch.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

export class GitHubTokenMissingError extends Error {
  constructor() {
    super(
      'No GitHub token configured: set a PAT or configure GitHub App (appId + privateKey + installationId)'
    );
    this.name = 'GitHubTokenMissingError';
  }
}

/**
 * A platform credential was asked for on a host other than the one it belongs
 * to. Standing configuration, not a transient failure.
 */
export class PlatformCredentialHostError extends Error {
  constructor(readonly apiUrl: string) {
    super(
      `A platform GitHub credential is valid only on the GitHub host it belongs to and is not sent to ${apiUrl}. That host is reachable with a platform credential configured for it (Admin > Integrations > GitHub > Host credentials) or a user's own saved token.`
    );
    this.name = 'PlatformCredentialHostError';
  }
}

/**
 * A token restricted to one repository was refused: GitHub answers 422 when a
 * named repository is not one the installation can see — the repository was
 * renamed (the stored name is stale), or it is not selected for the App.
 * Standing configuration, not a transient failure.
 */
export class RepositoryNotVisibleError extends Error {
  constructor(
    readonly repository: string,
    readonly installationId: string
  ) {
    super(
      `Repository ${repository} is not visible to GitHub App installation ${installationId}: it was renamed, or it is not selected for the App. Check the repository's name and the installation's repository access.`
    );
    this.name = 'RepositoryNotVisibleError';
  }
}

interface CachedInstallToken {
  token: string;
  /** Epoch ms, already reduced by the safety margin below. */
  expiresAt: number;
  /** Detects credential rotation — see `credentialFingerprint`. */
  fingerprint: string;
}

/**
 * One entry per installation, host and repository scope.
 *
 * Never pruned: an entry is replaced when its token is next minted. Bounded in
 * practice by the number of repositories the platform works on, each entry being
 * a short string. A `Map` keyed by installation and scope is the whole point:
 * the previous single slot made a second installation evict the first on every
 * alternating call, and a narrow token must never stand in for a wider one.
 */
const tokenCache = new Map<string, CachedInstallToken>();

/** Drop cached tokens. Exported for tests and for credential rotation. */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * Fingerprint of the signing credentials, so rotating the App private key or
 * changing the App id invalidates cached tokens without holding a second copy
 * of the key in memory.
 *
 * Hashed, not sliced. Both previous copies of this code fingerprinted the key
 * as `appPrivateKey.slice(-20)`, and the last twenty characters of a PEM are
 * its footer — `D PRIVATE KEY-----\n`, byte-identical for every key ever
 * generated. So the fingerprint was a constant, and a rotated key kept serving
 * tokens minted with the old one until they expired, which is the opposite of
 * what the comment above it claimed. A digest is one line and cannot degrade
 * that way.
 */
function credentialFingerprint(config: ResolvedGitHubConfig): string {
  const keyDigest = config.appPrivateKey
    ? createHash('sha256').update(config.appPrivateKey).digest('hex').slice(0, 16)
    : '';
  return `${config.appId}|${keyDigest}`;
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: now + 600, iat: now - 60, iss: appId })
  ).toString('base64url');
  const signing = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  return `${signing}.${signer.sign(privateKey).toString('base64url')}`;
}

/** Serve a token no closer than this to its declared expiry. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/** What to restrict a minted token to: names as stored, immutable ids, or nothing. */
type MintScope = { repositories: readonly string[] } | { repositoryIds: readonly number[] } | null;

/**
 * GitHub answers 422 to a restricted mint both for "Validation failed, or the
 * endpoint has been spammed" and for a repository the installation cannot see:
 * "There is at least one repository that does not exist or is not accessible to
 * the parent installation." Only the second is a standing condition, so the
 * message decides; anything else stays an ordinary, retryable failure.
 */
const NOT_ACCESSIBLE_RE = /does not exist|not accessible/i;

async function fetchInstallationToken(
  config: ResolvedGitHubConfig,
  installationId: string,
  apiUrl: string,
  scope: MintScope
): Promise<{ token: string; expiresAt: number } | 'not-accessible'> {
  const { appId, appPrivateKey } = config;
  if (!(appId && appPrivateKey)) {
    throw new Error(
      'GitHub App auth requires appId, appPrivateKey, and an installation id to all be configured'
    );
  }
  // Both interpolations are defended here rather than trusted from the caller.
  // The per-installation rows are validated as numeric at the API, but the
  // singleton `GitHubConfig.appInstallationId` is only length-checked, so a
  // value containing slashes would redirect the App JWT to a different path on
  // the configured host. And `apiUrl` is operator-entered, so a trailing slash
  // would produce a doubled one — the identity helpers already strip it and
  // this did not.
  if (!/^[0-9]+$/.test(installationId)) {
    throw new Error(
      `GitHub installation id must be numeric; got '${installationId.slice(0, 32)}'. Check the App installation id on the GitHub integration page.`
    );
  }
  const body =
    scope && 'repositories' in scope
      ? scope.repositories.length > 0
        ? { repositories: scope.repositories }
        : null
      : scope && scope.repositoryIds.length > 0
        ? { repository_ids: scope.repositoryIds }
        : null;
  const base = apiUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/app/installations/${installationId}/access_tokens`, {
    // With a restriction GitHub narrows the token to it; with none the request
    // has no body and the token carries the installation's full scope.
    // `permissions` is deliberately not narrowed: the token keeps the App's.
    ...(body && { body: JSON.stringify(body) }),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${createGitHubAppJwt(appId, appPrivateKey)}`,
      ...(body && { 'Content-Type': 'application/json' }),
      'User-Agent': 'auto-swe/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 422 && body) {
    // The response is read only to classify it. Its text is never put in an
    // error or a log.
    const detail = (await res.json().catch(() => ({}))) as { message?: unknown };
    if (typeof detail.message === 'string' && NOT_ACCESSIBLE_RE.test(detail.message)) {
      return 'not-accessible';
    }
    throw new Error(`GitHub App installation token request failed: 422 ${res.statusText}`);
  }
  if (!res.ok) {
    const failure = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub App installation token request failed: ${res.status} ${failure.message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  return {
    expiresAt: new Date(data.expires_at).getTime() - EXPIRY_SAFETY_MARGIN_MS,
    token: data.token,
  };
}

/**
 * The repository's immutable id, owner and current name, as GitHub knows it now:
 * `GET /repos/{owner}/{name}`, which follows a rename by redirect. Null when the
 * repository is not found. Authenticated with `token` — the caller's unscoped
 * installation token, which is used here and nowhere else — and the request
 * stays on the API's own origin.
 */
async function lookupRepository(
  base: string,
  token: string,
  owner: string,
  name: string
): Promise<{ id: number; owner: string; name: string } | null> {
  const origin = new URL(base).origin;
  const res = await fetchGuarded(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    },
    {
      check: (url) => url.origin === origin,
      credentialOrigin: origin,
      // Bare `fetch`, as the mint above: the App JWT already goes to this same
      // `apiUrl`, whose host is governed by `github.repositoryHosts` and the
      // credential host guard (a private GHE host is legitimate). Late-bound so
      // the call goes through whatever `fetch` is current.
      fetchImpl: (input, init) => fetch(input, init),
    }
  );
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GitHub repository lookup failed: ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as {
    full_name?: unknown;
    id?: unknown;
    name?: unknown;
    owner?: { login?: unknown } | null;
  } | null;
  const resolvedOwner =
    typeof data?.owner?.login === 'string'
      ? data.owner.login
      : typeof data?.full_name === 'string'
        ? data.full_name.split('/')[0]
        : '';
  return typeof data?.id === 'number' && typeof data.name === 'string' && resolvedOwner
    ? { id: data.id, name: data.name, owner: resolvedOwner }
    : null;
}

/** What GitHub says about one installation of an App. */
export interface AppInstallationState {
  /** `deleted` is a 404: the installation no longer exists. */
  state: 'active' | 'suspended' | 'deleted';
  /** The account the App is installed on, as GitHub reports it now. */
  accountLogin: string | null;
}

/**
 * Ask GitHub about one installation of the App in `config`: `GET
 * /app/installations/{id}`, authenticated with that App's JWT. Used to confirm
 * a webhook's claim before acting on it, since a delivery can be forged or
 * replayed by anyone holding the webhook secret.
 *
 * The JWT goes only to the host the credential set belongs to (the same rule as
 * `resolveGitHubToken`). Throws when the set has no App credentials, the id is
 * not numeric, the host is refused, or GitHub answers anything but 200 or 404.
 */
export async function fetchAppInstallation(
  config: ResolvedGitHubConfig,
  installationId: string,
  apiUrl: string = config.apiUrl
): Promise<AppInstallationState> {
  const { appId, appPrivateKey } = config;
  if (!(appId && appPrivateKey)) {
    throw new GitHubTokenMissingError();
  }
  if (!/^[0-9]+$/.test(installationId)) {
    throw new Error('GitHub installation id must be numeric');
  }
  if (hostFamily(apiUrl) !== (config.credentialHost ?? hostFamily(config.apiUrl))) {
    throw new PlatformCredentialHostError(apiUrl);
  }
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/app/installations/${installationId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${createGitHubAppJwt(appId, appPrivateKey)}`,
      'User-Agent': 'auto-swe/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    return { accountLogin: null, state: 'deleted' };
  }
  if (!res.ok) {
    throw new Error(`GitHub installation lookup failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    account?: { login?: unknown } | null;
    suspended_at?: unknown;
  };
  return {
    accountLogin: typeof body.account?.login === 'string' ? body.account.login : null,
    state: body.suspended_at ? 'suspended' : 'active',
  };
}

/** Which installation a caller wants a token for, and where its API lives. */
export interface InstallationTarget {
  /**
   * GitHub's numeric installation id. Null falls back to the singleton
   * `appInstallationId`, which is what every call site meant before more than
   * one installation was expressible.
   */
  installationId?: string | null;
  /** Per-installation API base, for a GitHub Enterprise host. */
  apiUrl?: string | null;
  /**
   * The account the named repositories belong to. Needed only to find a
   * repository again by its immutable id when its stored name has gone stale
   * (a rename); without it a stale name is a `RepositoryNotVisibleError`.
   */
  owner?: string | null;
  /**
   * Repository names (without the owner) the App token is restricted to, all
   * under the installation's account. Empty or omitted leaves the token with the
   * installation's full repository scope, which is right only for work that
   * spans the installation (listing its repositories, an admin sweep). A PAT
   * cannot be narrowed, so this has no effect on one.
   */
  repositories?: readonly string[];
}

/** The names as given, without blanks or repeats. */
function requestedRepositories(repositories: readonly string[] | undefined): string[] {
  return [...new Set((repositories ?? []).filter(Boolean))];
}

/**
 * The cache's spelling of a scope: order- and case-insensitive, because GitHub
 * repository names are case-insensitive. Only the key is folded; the request
 * carries the names as stored.
 */
function scopeKey(repositories: readonly string[]): string {
  return [...new Set(repositories.map((r) => r.toLowerCase()))].sort().join(',');
}

/**
 * The fallback for a scoped mint that GitHub refused as not accessible: resolve
 * the repository's id with the unscoped token, then mint once more restricted
 * to that id. The unscoped token stays inside this function. Throws
 * `RepositoryNotVisibleError` when the repository is not found or the id is
 * refused too.
 */
async function mintByRepositoryId(
  config: ResolvedGitHubConfig,
  from: {
    apiUrl: string;
    installationId: string;
    owner: string | null;
    repositories: readonly string[];
  }
): Promise<{ entry: { token: string; expiresAt: number } }> {
  const { apiUrl, installationId, owner, repositories } = from;
  const notVisible = new RepositoryNotVisibleError(repositories.join(', '), installationId);
  // One repository is the only scope this resolves; and the owner is needed to ask.
  if (!owner || repositories.length !== 1) {
    throw notVisible;
  }
  const name = repositories[0];
  const unscoped = await resolveGitHubToken(config, { apiUrl, installationId });
  const found = await lookupRepository(apiUrl.replace(/\/$/, ''), unscoped, owner, name);
  // A repository GitHub reports under another owner (a transfer) is not the
  // one this connection means, whatever its id.
  if (!found || found.owner.toLowerCase() !== owner.toLowerCase()) {
    throw notVisible;
  }
  const entry = await fetchInstallationToken(config, installationId, apiUrl, {
    repositoryIds: [found.id],
  });
  if (entry === 'not-accessible') {
    throw notVisible;
  }
  if (found.name.toLowerCase() !== name.toLowerCase()) {
    console.warn(
      `[githubInstallation] repository ${owner}/${name} is now ${found.owner}/${found.name}; update the connection's stored name. Its token is minted by repository id meanwhile.`
    );
  }
  return { entry };
}

/**
 * Resolve a credential for GitHub: an App installation token when the App is
 * configured, otherwise the PAT.
 *
 * `authMode` is honoured exactly as before — `'app'` forces the App path,
 * `'pat'` forces the PAT, and `'auto'` uses the App when it is fully
 * configured. What changed is only *which* installation the App path uses.
 */
export async function resolveGitHubToken(
  config: ResolvedGitHubConfig,
  target: InstallationTarget = {}
): Promise<string> {
  // The last line of the host rule (`githubHostScope.ts`), on the API-host
  // dimension: every platform credential — the PAT, an installation token, and
  // the App JWT that mints one — leaves through this function, so refusing here
  // covers a caller that forgot to ask. `config` is the credential set the
  // token is minted from (the instance's, or one host's own), so the check is
  // against the host that set belongs to: no credential goes to another host,
  // installation or not.
  const credentialHost = config.credentialHost ?? hostFamily(config.apiUrl);
  const effectiveApiUrl = target.apiUrl ?? config.apiUrl;
  if (hostFamily(effectiveApiUrl) !== credentialHost) {
    throw new PlatformCredentialHostError(effectiveApiUrl);
  }
  const mode = config.authMode ?? 'auto';
  const installationId = target.installationId ?? config.appInstallationId;
  const appConfigured =
    Boolean(config.appId) && Boolean(config.appPrivateKey) && Boolean(installationId);
  const useApp = mode === 'app' || (mode === 'auto' && appConfigured);

  if (useApp) {
    if (!installationId) {
      // Typed, not a plain Error. A repository with no installation of its own
      // in a deployment that leaves the singleton id empty is a configuration
      // condition, and the worker maps only this class to a non-retryable
      // Temporal failure — a plain Error would be retried to exhaustion.
      throw new GitHubTokenMissingError();
    }
    const apiUrl = target.apiUrl ?? config.apiUrl;
    // Key on the installation *and* where it lives: the same numeric id on two
    // hosts (github.com and a GHE instance) is two different installations.
    // And on the repositories: a token narrowed to one repository must never be
    // served for a wider request, nor a wide one for a request that asked to be
    // narrowed. The scope part is empty for the unscoped token.
    const repositories = requestedRepositories(target.repositories);
    const cacheKey = `${installationId}@${apiUrl}#${scopeKey(repositories)}`;
    const fingerprint = credentialFingerprint(config);
    const hit = tokenCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt && hit.fingerprint === fingerprint) {
      return hit.token;
    }
    const minted = await fetchInstallationToken(
      config,
      installationId,
      apiUrl,
      repositories.length > 0 ? { repositories } : null
    );
    if (minted !== 'not-accessible') {
      tokenCache.set(cacheKey, { expiresAt: minted.expiresAt, fingerprint, token: minted.token });
      return minted.token;
    }
    // The stored name is not one the installation can see. A rename leaves the
    // repository reachable by its id, so find it by id once before concluding
    // it is not selected for the App.
    const byId = await mintByRepositoryId(config, {
      apiUrl,
      installationId,
      owner: target.owner ?? null,
      repositories,
    });
    tokenCache.set(cacheKey, { ...byId.entry, fingerprint });
    return byId.entry.token;
  }

  if (config.token) {
    return config.token;
  }

  throw new GitHubTokenMissingError();
}
