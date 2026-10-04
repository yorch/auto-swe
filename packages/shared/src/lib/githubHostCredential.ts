/**
 * Per-host platform GitHub credentials.
 *
 * `githubHostScope.ts` decides which credential set a repository's host calls
 * for; this resolves the set. The instance's is the `GitHubConfig` singleton
 * (`resolveGitHubConfig`). Another approved host's is a `GitHubHostCredential`
 * row, which this turns into the same `ResolvedGitHubConfig` shape — so the
 * token mechanics (`resolveGitHubToken`) run unchanged and its API-host guard
 * checks against the set the token comes from.
 *
 * A host's config is built from its row alone. Nothing of the instance's is
 * inherited — not the PAT, the App, the singleton installation id or the auth
 * mode — because inheriting any of it would send an instance credential to
 * another host, which is exactly what the scope rule exists to prevent.
 */

import { approvedRepositoryHosts } from './connectionCredential.js';
import { decryptSecret } from './crypto.js';
import {
  type HostScopedConfig,
  hostFamily,
  type InstallationScopedRepo,
  installationHostMismatch,
  platformCredentialScope,
} from './githubHostScope.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

// Lazy DB access, as in `systemConfig.ts`: importing this module must not
// require DATABASE_URL.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/** A host's usable credentials, decrypted. */
export interface HostCredential {
  /** The host family key (`github.com`, `ghe.example.com`, `<tenant>.ghe.com`). */
  host: string;
  token: string | null;
  appId: string | null;
  appPrivateKey: string | null;
}

/** The host family key for a `host[:port]` string. */
export function hostKeyOf(hostPort: string): string {
  return hostFamily(`https://${hostPort}`);
}

/**
 * The credentials configured for `host`, or null when there are none usable:
 * no row, a row with neither a PAT nor a complete App, or a host that is no
 * longer approved (`github.repositoryHosts`) — an approval that lapsed takes the
 * credentials with it, as it does the webhook secret.
 *
 * A stored secret that cannot be decrypted throws, as the instance's does.
 */
export async function resolveHostCredential(host: string): Promise<HostCredential | null> {
  const key = hostKeyOf(host);
  const row = await (await db()).gitHubHostCredential.findUnique({ where: { host: key } });
  if (!row) {
    return null;
  }
  const decrypt = (
    ciphertext: Uint8Array | null,
    nonce: Uint8Array | null,
    authTag: Uint8Array | null,
    keyVersion: number | null
  ) =>
    ciphertext && nonce && authTag && keyVersion !== null
      ? decryptSecret({ authTag, ciphertext, keyVersion, nonce })
      : null;
  const token = decrypt(row.tokenCiphertext, row.tokenNonce, row.tokenAuthTag, row.tokenKeyVersion);
  const privateKey = decrypt(
    row.appPrivateKeyCiphertext,
    row.appPrivateKeyNonce,
    row.appPrivateKeyAuthTag,
    row.appPrivateKeyKeyVersion
  );
  const appId = row.appId && privateKey ? row.appId : null;
  if (!(token || appId)) {
    return null;
  }
  const approved = (await approvedRepositoryHosts()).map(hostKeyOf);
  if (!approved.includes(key)) {
    return null;
  }
  return { appId, appPrivateKey: appId ? privateKey : null, host: key, token };
}

/**
 * The `ResolvedGitHubConfig` for one host's credential set, with the base URLs
 * of the repository being reached (any spelling of the host family will do —
 * `resolveGitHubToken` compares families).
 */
export function hostCredentialConfig(
  credential: HostCredential,
  urls: { baseUrl: string; apiUrl: string }
): ResolvedGitHubConfig {
  return {
    apiUrl: urls.apiUrl,
    appClientId: null,
    appClientSecret: null,
    appId: credential.appId,
    // A host's App has no singleton installation: each repository names its own.
    appInstallationId: null,
    appPrivateKey: credential.appPrivateKey,
    authMode: null,
    baseUrl: urls.baseUrl,
    credentialHost: credential.host,
    oauthClientId: null,
    oauthClientSecret: null,
    token: credential.token,
    webhookSecret: null,
  };
}

/** The credential set a repository's host calls for. */
export type PlatformCredential =
  /** The instance's own set (the `GitHubConfig` singleton). */
  | { scope: 'instance'; config: ResolvedGitHubConfig }
  /** Another approved host's own set. `config` carries nothing of the instance's. */
  | { scope: 'host'; host: string; config: ResolvedGitHubConfig }
  /** Another host with no usable credentials: no platform credential applies. */
  | { scope: 'mismatch'; host: string }
  /** Web and API hosts differ: no credential of any kind may be attached. */
  | { scope: 'misconfigured' }
  /**
   * The repository's installation is recorded for another host: minting it
   * would ask this host's API for a different host's installation.
   */
  | { scope: 'installation-mismatch'; host: string };

/**
 * The credential set for `repo`: the instance's when it is on the instance's
 * host, its host's own when one is configured, otherwise none.
 *
 * Reads the database only when the repository is off the instance's host, so
 * the common case costs nothing.
 */
export async function resolvePlatformCredential(
  repo: InstallationScopedRepo,
  config: ResolvedGitHubConfig
): Promise<PlatformCredential> {
  return platformCredentialFor(repo, config, resolveHostCredential);
}

/** {@link resolvePlatformCredential} with the host lookup injected. */
export async function platformCredentialFor(
  repo: InstallationScopedRepo,
  config: ResolvedGitHubConfig,
  lookup: (host: string) => Promise<HostCredential | null>
): Promise<PlatformCredential> {
  const scoped: HostScopedConfig = config;
  const first = platformCredentialScope(repo, scoped);
  if (first === 'instance') {
    if (installationHostMismatch(repo, scoped)) {
      return { host: hostFamily(config.baseUrl), scope: 'installation-mismatch' };
    }
    return { config, scope: 'instance' };
  }
  if (first === 'misconfigured') {
    return { scope: 'misconfigured' };
  }
  const urls = {
    apiUrl: repo.apiUrl ?? config.apiUrl,
    baseUrl: repo.baseUrl ?? config.baseUrl,
  };
  const host = hostFamily(urls.baseUrl);
  const credential = await lookup(host);
  if (!credential) {
    return { host, scope: 'mismatch' };
  }
  if (installationHostMismatch(repo, scoped)) {
    return { host, scope: 'installation-mismatch' };
  }
  return { config: hostCredentialConfig(credential, urls), host, scope: 'host' };
}
