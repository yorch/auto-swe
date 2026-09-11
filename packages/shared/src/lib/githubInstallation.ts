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
import type { ResolvedGitHubConfig } from './systemConfig.js';

export class GitHubTokenMissingError extends Error {
  constructor() {
    super(
      'No GitHub token configured: set a PAT or configure GitHub App (appId + privateKey + installationId)'
    );
    this.name = 'GitHubTokenMissingError';
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
 * One entry per installation id.
 *
 * Unbounded in principle; bounded in practice by how many installations an
 * operator configures, each entry being a short string. A `Map` keyed by
 * installation is the whole point: the previous single slot made a second
 * installation evict the first on every alternating call.
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

async function fetchInstallationToken(
  config: ResolvedGitHubConfig,
  installationId: string,
  apiUrl: string
): Promise<{ token: string; expiresAt: number }> {
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
  const base = apiUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/app/installations/${installationId}/access_tokens`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${createGitHubAppJwt(appId, appPrivateKey)}`,
      'User-Agent': 'auto-swe/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub App installation token request failed: ${res.status} ${body.message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  return {
    expiresAt: new Date(data.expires_at).getTime() - EXPIRY_SAFETY_MARGIN_MS,
    token: data.token,
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
    const cacheKey = `${installationId}@${apiUrl}`;
    const fingerprint = credentialFingerprint(config);
    const hit = tokenCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt && hit.fingerprint === fingerprint) {
      return hit.token;
    }
    const { token, expiresAt } = await fetchInstallationToken(config, installationId, apiUrl);
    tokenCache.set(cacheKey, { expiresAt, fingerprint, token });
    return token;
  }

  if (config.token) {
    return config.token;
  }

  throw new GitHubTokenMissingError();
}
