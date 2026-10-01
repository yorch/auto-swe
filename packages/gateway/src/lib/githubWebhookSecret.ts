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

/**
 * The secret to verify a delivery with, or null when none is configured.
 * A stored host secret that cannot be decrypted throws: falling back to the
 * instance secret would verify the delivery against the wrong credential.
 */
export async function resolveWebhookSecret(
  prisma: PrismaClient,
  enterpriseHostHeader: string | string[] | undefined
): Promise<string | null> {
  const host = enterpriseHostOf(enterpriseHostHeader);
  if (host) {
    const row = await prisma.gitHubHostWebhookSecret.findUnique({ where: { host } });
    if (row) {
      return decryptSecret({
        authTag: row.secretAuthTag,
        ciphertext: row.secretCiphertext,
        keyVersion: row.secretKeyVersion,
        nonce: row.secretNonce,
      });
    }
  }
  return (await resolveGitHubConfig()).webhookSecret;
}
