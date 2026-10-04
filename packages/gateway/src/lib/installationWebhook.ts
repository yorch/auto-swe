/**
 * GitHub App `installation` and `installation_target` events.
 *
 * Keeps the registered `GitHubInstallation` rows in step with what GitHub says
 * happened to them: an uninstall or a suspension retires the installation, an
 * unsuspension reactivates it, and an account rename updates `accountLogin`.
 * Registration stays an admin action — an event for an installation nobody
 * registered changes nothing, so a delivery can never add a credential path.
 *
 * Each delivery is bound to the host its secret proved, exactly as the
 * repository deliveries are (`lib/repositoryHost.ts`): a per-host secret reaches
 * only that host's installations, and the instance secret reaches only the
 * instance host's (`host = ''`), never a host that has a webhook secret of its
 * own. The lookup is by `(host, installationId)`, because a numeric
 * installation id is only unique per host.
 *
 * A webhook only reverses what a webhook did. `retiredReason` records that a
 * retirement came from GitHub; an admin's own retirement leaves it null, so an
 * `unsuspend` can never reactivate an installation an admin chose to retire.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { hostKeyOf } from '@auto-swe/shared/lib/githubHostCredential';
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAuditLog } from './auditLog.js';
import { claimsHostWithOwnSecret, deliveryHostMatches } from './repositoryHost.js';

export const INSTALLATION_EVENT_TYPES = new Set(['installation', 'installation_target']);

const InstallationPayloadSchema = z.object({
  account: z
    .object({ login: z.string().min(1) })
    .partial()
    .optional(),
  action: z.string(),
  installation: z.object({
    account: z
      .object({ login: z.string().min(1) })
      .partial()
      .optional(),
    html_url: z.string().optional(),
    id: z.union([z.number(), z.string()]),
  }),
});

export type InstallationEventOutcome =
  | { ignored: true; reason: string }
  | { ignored?: undefined; installationId: string; host: string; changed: string[] };

const WEBHOOK_SUSPEND = 'webhook:suspend';
const WEBHOOK_DELETED = 'webhook:deleted';

/** The host an instance-secret delivery proves it came from: the instance's. */
async function instanceSecretHostMatches(htmlUrl: string | undefined): Promise<boolean> {
  if (!htmlUrl) {
    return true;
  }
  try {
    return hostFamily(htmlUrl) === hostFamily((await resolveGitHubConfig()).baseUrl);
  } catch {
    return false;
  }
}

/**
 * Apply one verified delivery. `verifiedHost` is the host the verifying secret
 * proved (`resolveWebhookSecret`): a per-host row's host, or null for the
 * instance secret. Never throws on an unknown installation or an event that
 * changes nothing.
 */
export async function applyInstallationEvent(
  fastify: FastifyInstance,
  eventType: string,
  body: unknown,
  verifiedHost: string | null
): Promise<InstallationEventOutcome> {
  const parsed = InstallationPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return { ignored: true, reason: 'Unrecognized payload shape' };
  }
  const { action, installation } = parsed.data;
  const htmlUrl = installation.html_url;

  // Bind the delivery to its host before reading a row.
  const prisma: PrismaClient = fastify.prisma;
  if (
    !deliveryHostMatches(verifiedHost, htmlUrl) ||
    (await claimsHostWithOwnSecret(prisma, verifiedHost, htmlUrl)) ||
    (verifiedHost === null && !(await instanceSecretHostMatches(htmlUrl)))
  ) {
    return { ignored: true, reason: 'Installation is not on the host that signed this delivery' };
  }
  const host = verifiedHost === null ? '' : hostKeyOf(verifiedHost);
  const installationId = String(installation.id);

  const row = await prisma.gitHubInstallation.findUnique({
    where: { host_installationId: { host, installationId } },
  });
  if (!row) {
    // Registration is an admin action; GitHub cannot add an installation.
    return { ignored: true, reason: 'Installation is not registered' };
  }

  const data: { accountLogin?: string; isActive?: boolean; retiredReason?: string | null } = {};
  if (eventType === 'installation') {
    if (action === 'deleted' || action === 'suspend') {
      const reason = action === 'deleted' ? WEBHOOK_DELETED : WEBHOOK_SUSPEND;
      if (row.isActive) {
        data.isActive = false;
        data.retiredReason = reason;
      } else if (row.retiredReason === WEBHOOK_SUSPEND && action === 'deleted') {
        // Already retired by a suspension; an uninstall supersedes it, and an
        // uninstalled installation is never reactivated by an unsuspend.
        data.retiredReason = reason;
      }
      // Already retired by an admin: left exactly as it is.
    } else if (action === 'unsuspend') {
      if (!row.isActive && row.retiredReason === WEBHOOK_SUSPEND) {
        data.isActive = true;
        data.retiredReason = null;
      }
    } else {
      return { ignored: true, reason: `installation ${action} changes nothing here` };
    }
  } else if (eventType === 'installation_target' && action === 'renamed') {
    const login = parsed.data.account?.login ?? installation.account?.login;
    if (login && login !== row.accountLogin) {
      data.accountLogin = login;
    }
  } else {
    return { ignored: true, reason: `${eventType} ${action} changes nothing here` };
  }

  const changed = Object.keys(data);
  if (changed.length === 0) {
    return { changed, host, installationId };
  }
  const updated = await prisma.gitHubInstallation.update({ data, where: { id: row.id } });
  try {
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor: null,
      after: {
        accountLogin: updated.accountLogin,
        isActive: updated.isActive,
        retiredReason: updated.retiredReason,
        source: `webhook:${eventType}.${action}`,
      },
      before: {
        accountLogin: row.accountLogin,
        host: row.host,
        installationId: row.installationId,
        isActive: row.isActive,
        retiredReason: row.retiredReason,
      },
      entityId: row.id,
      entityType: 'GitHubInstallation',
    });
  } catch (err) {
    // The change already applied; losing the record is bad, undoing a
    // retirement GitHub reported is worse. Said loudly, not swallowed.
    fastify.log.error({ err, host, installationId }, 'could not audit an installation webhook');
  }
  return { changed, host, installationId };
}
