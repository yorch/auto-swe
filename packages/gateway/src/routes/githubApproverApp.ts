/**
 * The GitHub "approver App": a second GitHub App identity whose only job is to submit an approving
 * review on a pull request the platform opened.
 *
 * It is stored apart from the instance's `GitHubConfig` App because GitHub refuses a self-approval,
 * so the two must be different Apps and must never be interchangeable. It has no environment
 * fallback: an unset approver App means no approver, never "use the main App".
 *
 * ADMIN-only. The private key is write-only: sealed on the way in, and the API reports only its last
 * four characters. Audit entries name the fields a change touched, never a value.
 */
import { createPrivateKey } from 'node:crypto';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { fetchGitHubAppIdentity } from '@auto-swe/shared/lib/githubInstallation';
import {
  resolveGitHubApproverAppConfig,
  resolveGitHubConfig,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { GLOBAL_SWEEP_CAP, sweepArmedPullRequests } from '../lib/prEvaluationSweep.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** Fixed entity id for `ConfigAuditLog`, whose entity column is a UUID; the table's key is 'default'. */
const AUDIT_ENTITY_ID = '00000000-0000-0000-0001-000000000014';

const APP_ID_RE = /^[0-9]{1,100}$/;
const APP_SLUG_RE = /^[a-z0-9-]{1,100}$/;

/** Shape only; each value is checked in the handler so a refusal names its field. */
const PutBody = z.object({
  appId: z.string().max(200).nullable().optional(),
  appSlug: z.string().max(200).nullable().optional(),
  privateKey: z.string().max(10_000).optional(),
});

function isRsaPem(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** Slugs of removed or replaced Apps kept so their approvals can still be recognised and withdrawn. */
const MAX_RETIRED_SLUGS = 5;

/**
 * The retired list after `retiring` leaves service and `active` takes (or keeps) the slot: lower-case,
 * de-duplicated, oldest first, the active slug never in it, at most five (the oldest dropped).
 */
function nextRetired(
  existing: readonly string[],
  retiring: string | null,
  active: string | null
): string[] {
  const merged = [...existing, ...(retiring ? [retiring] : [])].map((s) => s.toLowerCase());
  const activeLower = active?.toLowerCase() ?? null;
  const seen = new Set<string>();
  const kept: string[] = [];
  // Newest wins a duplicate: walk from the end, so a slug listed twice stays at its newest place.
  for (const slug of merged.reverse()) {
    if (slug !== activeLower && !seen.has(slug)) {
      seen.add(slug);
      kept.push(slug);
    }
  }
  return kept.slice(0, MAX_RETIRED_SLUGS).reverse();
}

const EMPTY_KEY = {
  privateKeyAuthTag: null,
  privateKeyCiphertext: null,
  privateKeyKeyVersion: null,
  privateKeyLastFour: null,
  privateKeyNonce: null,
};

interface Row {
  appId: string | null;
  appSlug: string | null;
  retiredAppSlugs: string[];
  privateKeyCiphertext: Uint8Array | null;
  privateKeyLastFour: string | null;
  updatedAt: Date;
}

function present(row: Row | null) {
  const hasKey = row?.privateKeyCiphertext != null;
  return {
    appId: row?.appId ?? null,
    appSlug: row?.appSlug ?? null,
    configured: Boolean(row?.appId && row.appSlug && hasKey),
    privateKeyLastFour: hasKey ? (row?.privateKeyLastFour ?? null) : null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The fields a row holds, by name only. */
function setFields(row: Row | null): string[] {
  if (!row) {
    return [];
  }
  return [
    ...(row.appId ? ['appId'] : []),
    ...(row.appSlug ? ['appSlug'] : []),
    ...(row.privateKeyCiphertext ? ['privateKey'] : []),
  ];
}

function invalid(
  reply: Parameters<typeof sendError>[0],
  code: string,
  field: string,
  message: string
) {
  return sendError(reply, 400, code, message, { field });
}

export const githubApproverAppRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  /**
   * Whatever the approver App approved stands on GitHub, and the status it earned stands with it.
   * Replacing or removing the credentials changes who is recognised as the approver, so every open
   * pull request is re-evaluated, on the same selection as the kill switch, and the worker
   * withdraws what no longer holds. Runs after the write; never throws and never fails the
   * request. Returns the number of pull requests selected, or 0.
   */
  async function reevaluateAfterCredentialChange(log: FastifyBaseLogger): Promise<number> {
    try {
      const swept = await sweepArmedPullRequests(fastify, log, { cap: GLOBAL_SWEEP_CAP });
      return swept.found;
    } catch (err) {
      log.error(
        { errorName: err instanceof Error ? err.name : 'unknown' },
        'the re-evaluation after an approver App credential change could not start (non-fatal)'
      );
      return 0;
    }
  }

  app.get('/github-approver-app', { onRequest: adminOnly }, async () =>
    present(await fastify.prisma.gitHubApproverApp.findUnique({ where: { id: 'default' } }))
  );

  app.put(
    '/github-approver-app',
    { onRequest: adminOnly, schema: { body: PutBody } },
    async (request, reply) => {
      const user = requireUser(request);
      const { appId, appSlug, privateKey } = request.body;

      if (appId !== undefined && appId !== null && !APP_ID_RE.test(appId)) {
        return invalid(reply, 'INVALID_APP_ID', 'appId', 'appId must be the numeric GitHub App id');
      }
      if (appSlug !== undefined && appSlug !== null && !APP_SLUG_RE.test(appSlug)) {
        return invalid(
          reply,
          'INVALID_APP_SLUG',
          'appSlug',
          'appSlug may contain only lowercase letters, digits and hyphens'
        );
      }
      // A blank key means "keep the stored one"; anything else must be an RSA PEM.
      const newKey = privateKey === undefined || privateKey === '' ? undefined : privateKey;
      if (newKey !== undefined && !isRsaPem(newKey)) {
        return invalid(
          reply,
          'INVALID_PRIVATE_KEY',
          'privateKey',
          'privateKey must be a PEM-encoded RSA private key'
        );
      }

      const existing = await fastify.prisma.gitHubApproverApp.findUnique({
        where: { id: 'default' },
      });

      // The two identities must differ: GitHub refuses an App approving its own pull request.
      const nextAppId = appId === undefined ? (existing?.appId ?? null) : appId;
      if (nextAppId) {
        const main = await resolveGitHubConfig();
        if (main.appId && main.appId === nextAppId) {
          return invalid(
            reply,
            'APPROVER_APP_IS_MAIN_APP',
            'appId',
            'The approver App must be a different GitHub App from the one in the GitHub integration; GitHub does not allow an App to approve its own pull requests'
          );
        }
      }

      // A wrong slug leaves every approval unrecognisable, and another App's slug would make its
      // reviews pass as ours: GitHub is asked who the key's App is before anything is stored. A
      // check that cannot be made refuses too; nothing is saved unverified.
      const nextSlug = appSlug === undefined ? (existing?.appSlug ?? null) : appSlug;
      const nextKey = newKey ?? (await resolveGitHubApproverAppConfig())?.privateKey ?? null;
      const touched = appId !== undefined || appSlug !== undefined || newKey !== undefined;
      if (touched && nextAppId && nextSlug && nextKey) {
        const identity = await fetchGitHubAppIdentity({
          apiUrl: (await resolveGitHubConfig()).apiUrl,
          appId: nextAppId,
          privateKey: nextKey,
        });
        if (!identity.ok && identity.reason === 'unreachable') {
          return sendError(
            reply,
            502,
            'APPROVER_APP_UNREACHABLE',
            'GitHub could not be reached to verify the approver App, so nothing was saved'
          );
        }
        if (!identity.ok || identity.id !== nextAppId || identity.slug.toLowerCase() !== nextSlug) {
          return sendError(
            reply,
            400,
            'APPROVER_APP_UNVERIFIED',
            'GitHub did not confirm this App id, slug and private key as one App, so nothing was saved'
          );
        }
      }

      const changedFields = [
        ...(appId !== undefined ? ['appId'] : []),
        ...(appSlug !== undefined ? ['appSlug'] : []),
        ...(newKey !== undefined ? ['privateKey'] : []),
      ];
      if (changedFields.length === 0) {
        return present(existing);
      }

      const data: Record<string, unknown> = { updatedById: user.sub };
      if (appId !== undefined) {
        data.appId = appId;
      }
      if (appSlug !== undefined) {
        data.appSlug = appSlug;
      }
      const identityChanged =
        (appId !== undefined && appId !== (existing?.appId ?? null)) ||
        (appSlug !== undefined && appSlug !== (existing?.appSlug ?? null));
      if (identityChanged) {
        // The App being replaced may have approved pull requests: keep its slug to withdraw them.
        data.retiredAppSlugs = nextRetired(
          existing?.retiredAppSlugs ?? [],
          existing?.appSlug ?? null,
          nextSlug
        );
      }
      if (newKey !== undefined) {
        const e = encryptSecret(newKey);
        data.privateKeyAuthTag = e.authTag;
        data.privateKeyCiphertext = e.ciphertext;
        data.privateKeyKeyVersion = e.keyVersion;
        data.privateKeyLastFour = e.lastFour;
        data.privateKeyNonce = e.nonce;
      }
      const saved = await fastify.prisma.gitHubApproverApp.upsert({
        create: { id: 'default', ...data },
        update: data,
        where: { id: 'default' },
      });
      const credentialsChanged =
        newKey !== undefined ||
        (appId !== undefined && appId !== (existing?.appId ?? null)) ||
        (appSlug !== undefined && appSlug !== (existing?.appSlug ?? null));
      const swept = credentialsChanged ? await reevaluateAfterCredentialChange(request.log) : 0;
      await writeAuditLog(fastify, {
        action: existing ? 'UPDATE' : 'CREATE',
        actor: user,
        after: {
          changedFields,
          ...(swept > 0 ? { prEvaluationSweep: { pullRequests: swept } } : {}),
        },
        entityId: AUDIT_ENTITY_ID,
        entityType: 'GitHubApproverApp',
      });
      return present(saved);
    }
  );

  app.delete('/github-approver-app', { onRequest: adminOnly }, async (request, reply) => {
    const user = requireUser(request);
    const existing = await fastify.prisma.gitHubApproverApp.findUnique({
      where: { id: 'default' },
    });
    const cleared = setFields(existing);
    if (cleared.length === 0) {
      return reply.status(204).send();
    }
    // The sweep below runs after this write, so the removed slug must already be on the row: it is
    // the only way the withdrawal can still recognise the approvals the removed App gave.
    const data = {
      appId: null,
      appSlug: null,
      retiredAppSlugs: nextRetired(
        existing?.retiredAppSlugs ?? [],
        existing?.appSlug ?? null,
        null
      ),
      ...EMPTY_KEY,
      updatedById: user.sub,
    };
    await fastify.prisma.gitHubApproverApp.upsert({
      create: { id: 'default', ...data },
      update: data,
      where: { id: 'default' },
    });
    const swept = await reevaluateAfterCredentialChange(request.log);
    await writeAuditLog(fastify, {
      action: 'DELETE',
      actor: user,
      ...(swept > 0 ? { after: { prEvaluationSweep: { pullRequests: swept } } } : {}),
      before: { changedFields: cleared },
      entityId: AUDIT_ENTITY_ID,
      entityType: 'GitHubApproverApp',
    });
    return reply.status(204).send();
  });
};
