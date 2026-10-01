/**
 * Per-user GitHub credentials: one user's own token for one repository.
 *
 * The platform otherwise reaches GitHub with one credential an admin
 * configured. This lets a user bring their own instead — and it is used **only
 * for executions that user launched**. Every read here is keyed by
 * `(connectionId, userId)`, where `userId` is the person a run or a decision is
 * about; there is no lookup by repository alone, so no code path can pick
 * "whichever token this repo has" and act as somebody else.
 *
 * Two settings govern it, both ADMIN-only and deployment-wide:
 *
 *  - `github.userCredentialsEnabled` — the switch. Off, every resolver here
 *    returns null and saved rows are inert; they are kept, so switching it back
 *    on needs no re-entry.
 *  - `github.userCredentialHosts` — where a user token may be sent. A user
 *    cannot choose a destination an admin has not listed, which is what makes
 *    it safe to let a GitHub Enterprise host on a private network through: the
 *    admin approved that host by name, the same opt-in the tracker and
 *    knowledge-base connectors require for a private address.
 */
import { resolveSettings } from '../config/index.js';
import type { PrismaClient } from '../index.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { resolveGitHubConfig } from './systemConfig.js';

/** Columns of an encrypted `ConnectionCredential.token`. */
export interface EncryptedCredentialToken {
  tokenCiphertext: Uint8Array<ArrayBuffer>;
  tokenNonce: Uint8Array<ArrayBuffer>;
  tokenAuthTag: Uint8Array<ArrayBuffer>;
  tokenKeyVersion: number;
  tokenLastFour: string;
}

export function encryptCredentialToken(plaintext: string): EncryptedCredentialToken {
  const encrypted = encryptSecret(plaintext);
  return {
    tokenAuthTag: encrypted.authTag,
    tokenCiphertext: encrypted.ciphertext,
    tokenKeyVersion: encrypted.keyVersion,
    tokenLastFour: encrypted.lastFour,
    tokenNonce: encrypted.nonce,
  };
}

/** `https://host[:port]` for a URL, or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a user token may be sent to `url`.
 *
 * HTTPS only — a token sent in clear is a token published. The comparison is
 * on `host` (hostname plus any explicit port), so `ghe.corp:8443` must be
 * listed as such. `github.com` also admits `api.github.com`, because that is
 * where github.com's REST API lives and no admin listing one means to exclude
 * the other.
 *
 * Exact host matching only: no wildcards, no suffix matching. A suffix rule
 * would let `evil-github.com` or a subdomain someone else controls through.
 * A URL carrying userinfo, a query or a fragment is refused outright: these
 * URLs are base URLs that get concatenated into clone and API URLs, and each of
 * those parts is a way to make what git or curl parses differ from what was
 * checked here.
 */
export function credentialHostAllowed(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return false;
  }
  if (parsed.search || parsed.hash || url.includes('?') || url.includes('#')) {
    return false;
  }
  // Canonical form only. The WHATWG parser here and git/curl downstream do
  // not agree on every input — `https://github.com\@evil.example` is host
  // `github.com` to one and something else to the other — so a URL is accepted
  // only if it already reads exactly as it parses. That refuses backslashes,
  // a redundant `:443`, uppercase hosts and the like, none of which a real
  // GitHub base URL needs.
  const canonical = parsed.href;
  if (url !== canonical && `${url}/` !== canonical) {
    return false;
  }
  const host = parsed.host.toLowerCase();
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  if (allowed.has(host)) {
    return true;
  }
  return host === 'api.github.com' && allowed.has('github.com');
}

/** The policy both settings make up, read in one round trip. */
export async function resolveUserCredentialPolicy(): Promise<{
  enabled: boolean;
  hosts: readonly string[];
}> {
  const settings = await resolveSettings([
    'github.userCredentialsEnabled',
    'github.userCredentialHosts',
  ]);
  return {
    enabled: settings['github.userCredentialsEnabled'],
    hosts: settings['github.userCredentialHosts'],
  };
}

/** A token that may be used now, and the two bases it may be sent to. */
export interface UsableCredential {
  token: string;
  apiUrl: string;
  baseUrl: string;
}

/**
 * The token `userId` saved for `connectionId`, when it may be used right now.
 *
 * Null — the caller's cue to fall back to the platform credential, never to
 * look for somebody else's — when any of these fails:
 *
 *  - the feature is on;
 *  - the user saved a token for this repository;
 *  - the user is active, and still a member of the repository's team (or a
 *    platform ADMIN, consistent with every other repository check). Membership
 *    is the outer bound everywhere else; a token must not outlive it;
 *  - both of the repository's current bases — web for the clone, API for
 *    everything else — are on the allowlist;
 *  - and both still have the origins the token was verified against when it
 *    was saved. A team lead can repoint a repository; the token goes only
 *    where its owner confirmed it, so a repointed repository needs it saved
 *    again.
 *
 * Self-contained on purpose: it reads the repository's URLs itself rather than
 * taking them from the caller, so the launch gate, the sweep and the run all
 * apply the same checks to the same values and cannot drift apart.
 *
 * A database or decryption failure throws. Resolving it to null would quietly
 * switch the identity a run acts as from the user's to the platform's.
 */
export async function resolveUserCredential(
  prisma: PrismaClient,
  args: { connectionId: string; userId: string }
): Promise<UsableCredential | null> {
  const policy = await resolveUserCredentialPolicy();
  if (!policy.enabled) {
    return null;
  }
  const row = await prisma.connectionCredential.findUnique({
    select: {
      apiOrigin: true,
      connection: {
        select: {
          githubApiUrl: true,
          githubUrl: true,
          team: {
            select: {
              memberships: { select: { userId: true }, where: { userId: args.userId } },
            },
          },
        },
      },
      tokenAuthTag: true,
      tokenCiphertext: true,
      tokenKeyVersion: true,
      tokenNonce: true,
      user: { select: { isActive: true, role: true } },
      webOrigin: true,
    },
    where: { connectionId_userId: { connectionId: args.connectionId, userId: args.userId } },
  });
  if (!row?.user.isActive) {
    return null;
  }
  if (row.user.role !== 'ADMIN' && row.connection.team.memberships.length === 0) {
    return null;
  }

  const ghConfig = await resolveGitHubConfig();
  const apiUrl = row.connection.githubApiUrl ?? ghConfig.apiUrl;
  const baseUrl = row.connection.githubUrl ?? ghConfig.baseUrl;
  if (
    !(credentialHostAllowed(apiUrl, policy.hosts) && credentialHostAllowed(baseUrl, policy.hosts))
  ) {
    return null;
  }
  if (originOf(apiUrl) !== row.apiOrigin || originOf(baseUrl) !== row.webOrigin) {
    return null;
  }

  const token = decryptSecret({
    authTag: row.tokenAuthTag,
    ciphertext: row.tokenCiphertext,
    keyVersion: row.tokenKeyVersion,
    nonce: row.tokenNonce,
  });
  return { apiUrl, baseUrl, token };
}
