/**
 * GitHub App `installation` and `installation_target` events.
 *
 * Keeps the registered `GitHubInstallation` rows in step with what GitHub says
 * happened to them: an uninstall or a suspension retires the installation, an
 * unsuspension reactivates it, and an account rename updates `accountLogin`.
 * Registration stays an admin action: an event for an installation nobody
 * registered changes nothing, so a delivery can never add a credential path.
 *
 * **A delivery is a prompt to ask, never the state to apply.** The webhook
 * secret also goes on repository webhooks, so its holders can forge a delivery,
 * and a captured one can be replayed. So the state change always comes from
 * `GET /app/installations/{id}`, made with that host's own App JWT, and only
 * what GitHub reports now is applied: 404 is deleted, `suspended_at` is
 * suspended, otherwise active. A host with no App credentials, or a lookup that
 * fails, changes nothing. A forged or replayed event that GitHub contradicts is
 * therefore harmless, which also makes delivery-id deduplication unnecessary.
 *
 * Each delivery is bound to the host its secret proved, exactly as the
 * repository deliveries are (`lib/repositoryHost.ts`): a per-host secret reaches
 * only that host's installations, and the instance secret reaches only the
 * instance host's (`host = ''`), never a host that has a webhook secret of its
 * own. The lookup is by `(host, installationId)`, because a numeric
 * installation id is only unique per host.
 *
 * A webhook only reverses what a webhook did. `retiredReason` records that a
 * retirement came from GitHub; an admin's own retirement leaves it null, so a
 * report of "active" can never reactivate an installation an admin retired. The
 * write is conditional on the row as it was read, so an admin edit that lands
 * in between wins.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  hostCredentialConfig,
  hostKeyOf,
  resolveHostCredential,
} from '@auto-swe/shared/lib/githubHostCredential';
import { defaultApiUrlForHost, hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import {
  type AppInstallationState,
  fetchAppInstallation,
} from '@auto-swe/shared/lib/githubInstallation';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAuditLog } from './auditLog.js';
import { enterpriseHostOf } from './githubWebhookSecret.js';
import { claimsHostWithOwnSecret, deliveryHostMatches } from './repositoryHost.js';

export const INSTALLATION_EVENT_TYPES = new Set(['installation', 'installation_target']);

// `installation` is not documented as present on every event, and it is what
// names the installation to ask GitHub about, so a delivery without it is ignored.
const InstallationPayloadSchema = z.object({
  action: z.string(),
  installation: z
    .object({
      html_url: z.string().optional(),
      id: z.union([z.number(), z.string()]),
    })
    .optional(),
});

export type InstallationEventOutcome =
  | { ignored: true; reason: string }
  | { ignored?: undefined; installationId: string; host: string; changed: string[] };

const WEBHOOK_SUSPEND = 'webhook:suspend';
const WEBHOOK_DELETED = 'webhook:deleted';

/** The host an instance-secret delivery proves it came from: the instance's. */
async function instanceSecretHostMatches(
  htmlUrl: string | undefined,
  enterpriseHostHeader: string | string[] | undefined
): Promise<boolean> {
  const instanceFamily = hostFamily((await resolveGitHubConfig()).baseUrl);
  // A delivery that names another enterprise host but fell back to the instance
  // secret (that host has no secret of its own) is not the instance's.
  const header = enterpriseHostOf(enterpriseHostHeader);
  if (header && hostKeyOf(header) !== instanceFamily) {
    return false;
  }
  if (!htmlUrl) {
    return true;
  }
  try {
    return hostFamily(htmlUrl) === instanceFamily;
  } catch {
    return false;
  }
}

/**
 * What GitHub says about the installation now, from the App of the host the
 * delivery was bound to. Null when it cannot be asked (no App credentials for
 * the host, or the lookup failed): the caller changes nothing.
 */
async function askGitHub(
  fastify: FastifyInstance,
  host: string,
  installationId: string
): Promise<AppInstallationState | null> {
  try {
    if (host === '') {
      return await fetchAppInstallation(await resolveGitHubConfig(), installationId);
    }
    const credential = await resolveHostCredential(host);
    if (!credential) {
      fastify.log.warn(
        { host, installationId },
        'installation event for a host with no credentials'
      );
      return null;
    }
    const apiUrl = defaultApiUrlForHost(host);
    return await fetchAppInstallation(
      hostCredentialConfig(credential, { apiUrl, baseUrl: `https://${host}` }),
      installationId,
      apiUrl
    );
  } catch (err) {
    fastify.log.warn(
      { err, host, installationId },
      'could not confirm an installation event with GitHub; nothing changed'
    );
    return null;
  }
}

type Change = { accountLogin?: string; isActive?: boolean; retiredReason?: string | null };

/** The change that makes `row` agree with `observed`, or none. */
function changeFor(
  row: { accountLogin: string; isActive: boolean; retiredReason: string | null },
  observed: AppInstallationState,
  syncLogin: boolean
): Change {
  const change: Change = {};
  if (observed.state === 'active') {
    // Only a retirement a webhook made is reversed; an admin's stands.
    if (!row.isActive && row.retiredReason?.startsWith('webhook:')) {
      change.isActive = true;
      change.retiredReason = null;
    }
  } else {
    const reason = observed.state === 'deleted' ? WEBHOOK_DELETED : WEBHOOK_SUSPEND;
    if (row.isActive) {
      change.isActive = false;
      change.retiredReason = reason;
    } else if (row.retiredReason === WEBHOOK_SUSPEND && reason === WEBHOOK_DELETED) {
      change.retiredReason = reason;
    }
  }
  if (syncLogin && observed.accountLogin && observed.accountLogin !== row.accountLogin) {
    change.accountLogin = observed.accountLogin;
  }
  return change;
}

/**
 * Apply one verified delivery. `verifiedHost` is the host the verifying secret
 * proved (`resolveWebhookSecret`): a per-host row's host, or null for the
 * instance secret. `enterpriseHostHeader` is the raw `X-GitHub-Enterprise-Host`.
 * Never throws on an unknown installation or an event that changes nothing.
 */
export async function applyInstallationEvent(
  fastify: FastifyInstance,
  eventType: string,
  body: unknown,
  verifiedHost: string | null,
  enterpriseHostHeader?: string | string[]
): Promise<InstallationEventOutcome> {
  const parsed = InstallationPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return { ignored: true, reason: 'Unrecognized payload shape' };
  }
  const { action, installation } = parsed.data;
  const relevant =
    (eventType === 'installation' && ['deleted', 'suspend', 'unsuspend'].includes(action)) ||
    (eventType === 'installation_target' && action === 'renamed');
  if (!relevant) {
    return { ignored: true, reason: `${eventType} ${action} changes nothing here` };
  }
  if (!installation) {
    fastify.log.info({ action, eventType }, 'installation event without an installation; ignored');
    return { ignored: true, reason: 'Delivery does not name an installation' };
  }
  const htmlUrl = installation.html_url;

  // Bind the delivery to its host before reading a row.
  const prisma: PrismaClient = fastify.prisma;
  if (
    !deliveryHostMatches(verifiedHost, htmlUrl) ||
    (await claimsHostWithOwnSecret(prisma, verifiedHost, htmlUrl)) ||
    (verifiedHost === null && !(await instanceSecretHostMatches(htmlUrl, enterpriseHostHeader)))
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

  // Never trust the payload for the state: ask GitHub.
  const observed = await askGitHub(fastify, host, installationId);
  if (!observed) {
    return { ignored: true, reason: 'Could not confirm the installation with GitHub' };
  }
  const data = changeFor(row, observed, eventType === 'installation_target');
  const changed = Object.keys(data);
  if (changed.length === 0) {
    return { changed, host, installationId };
  }
  // Conditional on the row as read: an admin edit that landed since wins.
  const applied = await prisma.gitHubInstallation.updateMany({
    data,
    where: {
      accountLogin: row.accountLogin,
      id: row.id,
      isActive: row.isActive,
      retiredReason: row.retiredReason,
    },
  });
  if (applied.count === 0) {
    return { changed: [], host, installationId };
  }
  try {
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor: null,
      after: {
        accountLogin: data.accountLogin ?? row.accountLogin,
        confirmedWithGitHub: observed.state,
        isActive: data.isActive ?? row.isActive,
        retiredReason: data.retiredReason === undefined ? row.retiredReason : data.retiredReason,
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
    // retirement GitHub confirmed is worse. Said loudly, not swallowed.
    fastify.log.error({ err, host, installationId }, 'could not audit an installation webhook');
  }
  return { changed, host, installationId };
}
