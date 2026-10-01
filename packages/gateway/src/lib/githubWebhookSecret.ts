/**
 * Which secret a GitHub webhook delivery is verified with.
 *
 * The `GitHubConfig` singleton holds one webhook secret. Repositories on a
 * second GitHub Enterprise Server host are configured by that instance's own
 * admins, with a secret of their own. GitHub Enterprise Server names the
 * sending host in `X-GitHub-Enterprise-Host`, so a delivery that names a host
 * with a `GitHubHostWebhookSecret` row is verified with that row's secret and
 * nothing else.
 *
 * GitHub documents the header as a hostname. It matches the row for exactly
 * that `host[:port]`; failing that, the one row whose hostname is the
 * header's, whatever its port. A hostname shared by several rows with no exact
 * match matches none of them.
 *
 * A matched row whose host is no longer approved verifies nothing: the
 * delivery is refused, not handed to the instance secret.
 *
 * The result names the host the chosen secret proves (null for the instance
 * secret), so the handler can confine the delivery to repositories on that
 * host — see `lib/repositoryHost.ts`. A secret proves who sent the delivery,
 * not which repository it may act on.
 *
 * Exactly one secret is ever tried. Trying the host's and then the instance's
 * would let a payload signed with the instance secret be accepted as coming
 * from the enterprise host, which is the confusion per-host secrets exist to
 * remove. A host with no row falls back to the instance secret, so a
 * deployment that never adds a row behaves as it always did. github.com sends
 * no such header and so always uses the instance secret.
 *
 * Read on every delivery, not cached: webhooks are low volume, and a cached
 * secret would keep authenticating a rotated-out one.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { approvedRepositoryHosts } from '@auto-swe/shared/lib/connectionCredential';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';

/** The lowercased `host[:port]` a delivery names, or null when it names none. */
export function enterpriseHostOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const host = header.trim().toLowerCase();
  return host.length > 0 ? host : null;
}

/** The hostname of a `host[:port]`, lowercased. */
function hostnameOf(hostPort: string): string {
  try {
    return new URL(`https://${hostPort}`).hostname.toLowerCase();
  } catch {
    return hostPort.toLowerCase();
  }
}

/** The outcome of choosing a secret for a delivery. */
export type WebhookSecretResolution =
  /**
   * `host` is the row's host when a per-host secret was chosen, null for the
   * instance secret. `secret` is null when none is configured.
   */
  | { status: 'resolved'; secret: string | null; host: string | null }
  /** The header matched a row whose host is no longer approved. */
  | { status: 'host_not_approved'; host: string };

/**
 * The secret to verify a delivery with, and the host it proves.
 * A stored host secret that cannot be decrypted throws: falling back to the
 * instance secret would verify the delivery against the wrong credential.
 */
export async function resolveWebhookSecret(
  prisma: PrismaClient,
  enterpriseHostHeader: string | string[] | undefined
): Promise<WebhookSecretResolution> {
  const header = enterpriseHostOf(enterpriseHostHeader);
  if (header) {
    let row = await prisma.gitHubHostWebhookSecret.findUnique({ where: { host: header } });
    if (!row) {
      const hostname = hostnameOf(header);
      const sameHostname = (
        await prisma.gitHubHostWebhookSecret.findMany({
          where: { OR: [{ host: hostname }, { host: { startsWith: `${hostname}:` } }] },
        })
      ).filter((r) => hostnameOf(r.host) === hostname);
      row = sameHostname.length === 1 ? sameHostname[0] : null;
    }
    if (row) {
      if (!(await approvedRepositoryHosts()).includes(row.host)) {
        return { host: row.host, status: 'host_not_approved' };
      }
      return {
        host: row.host,
        secret: decryptSecret({
          authTag: row.secretAuthTag,
          ciphertext: row.secretCiphertext,
          keyVersion: row.secretKeyVersion,
          nonce: row.secretNonce,
        }),
        status: 'resolved',
      };
    }
  }
  return { host: null, secret: (await resolveGitHubConfig()).webhookSecret, status: 'resolved' };
}
