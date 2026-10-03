/**
 * Managing per-host platform GitHub credentials.
 *
 * The GitHub integration holds the instance's PAT and App, valid on the
 * instance's own host and nowhere else. A repository on another approved host
 * (`github.repositoryHosts`) is reached with that host's own platform
 * credential, recorded here: a PAT, a GitHub App (id and private key), or both.
 * A credential recorded for a host is sent to that host family only (see
 * `@auto-swe/shared/lib/githubHostScope`).
 *
 * ADMIN-only. Secrets are write-only: encrypted on the way in, and the API only
 * ever reports whether one is set and its last four characters.
 */
import { createPrivateKey } from 'node:crypto';
import { Prisma } from '@auto-swe/shared';
import { hostEntry } from '@auto-swe/shared/config';
import { approvedRepositoryHosts } from '@auto-swe/shared/lib/connectionCredential';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { hostKeyOf } from '@auto-swe/shared/lib/githubHostCredential';
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

// A pasted trailing newline is the common way to store a token that can never
// authenticate, so edge whitespace is refused rather than trimmed silently.
const TokenSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v === v.trim(), 'must not start or end with whitespace');

// A PEM legitimately ends in a newline, so it is only required to parse.
const PrivateKeySchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((v) => {
    try {
      createPrivateKey(v);
      return true;
    } catch {
      return false;
    }
  }, 'must be a PEM private key');

const AppIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[0-9]+$/, 'must be the numeric GitHub App id');

const CreateSchema = z.object({
  appId: AppIdSchema.optional(),
  appPrivateKey: PrivateKeySchema.optional(),
  host: hostEntry,
  token: TokenSchema.optional(),
});

/** `null` clears the field. */
const UpdateSchema = z.object({
  appId: AppIdSchema.nullable().optional(),
  appPrivateKey: PrivateKeySchema.nullable().optional(),
  token: TokenSchema.nullable().optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const isRecordNotFound = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';

type Row = Prisma.GitHubHostCredentialGetPayload<object>;

function present(row: Row) {
  return {
    appId: row.appId,
    appPrivateKeyLastFour: row.appPrivateKeyCiphertext ? row.appPrivateKeyLastFour : null,
    createdAt: row.createdAt,
    hasAppPrivateKey: row.appPrivateKeyCiphertext !== null,
    hasToken: row.tokenCiphertext !== null,
    host: row.host,
    id: row.id,
    tokenLastFour: row.tokenCiphertext ? row.tokenLastFour : null,
    updatedAt: row.updatedAt,
  };
}

/** What an audit entry says about a row: which secrets are set, never their values. */
function summary(row: Row) {
  const p = present(row);
  return {
    appId: p.appId,
    appPrivateKeyLastFour: p.appPrivateKeyLastFour,
    host: p.host,
    tokenLastFour: p.tokenLastFour,
  };
}

function tokenColumns(token: string | null) {
  if (token === null) {
    return {
      tokenAuthTag: null,
      tokenCiphertext: null,
      tokenKeyVersion: null,
      tokenLastFour: null,
      tokenNonce: null,
    };
  }
  const e = encryptSecret(token);
  return {
    tokenAuthTag: e.authTag,
    tokenCiphertext: e.ciphertext,
    tokenKeyVersion: e.keyVersion,
    tokenLastFour: e.lastFour,
    tokenNonce: e.nonce,
  };
}

function keyColumns(key: string | null) {
  if (key === null) {
    return {
      appPrivateKeyAuthTag: null,
      appPrivateKeyCiphertext: null,
      appPrivateKeyKeyVersion: null,
      appPrivateKeyLastFour: null,
      appPrivateKeyNonce: null,
    };
  }
  const e = encryptSecret(key);
  return {
    appPrivateKeyAuthTag: e.authTag,
    appPrivateKeyCiphertext: e.ciphertext,
    appPrivateKeyKeyVersion: e.keyVersion,
    appPrivateKeyLastFour: e.lastFour,
    appPrivateKeyNonce: e.nonce,
  };
}

export const githubHostCredentialRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });
  const notFound = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 404, 'HOST_CREDENTIAL_NOT_FOUND', 'No host credential with that id');

  /**
   * Why `host` cannot hold credentials, or null when it can: it must be an
   * approved host, and not the instance's own — the instance's credentials are
   * the GitHub integration's, and a second set for the same host would make
   * "which credential applies" ambiguous.
   */
  async function hostProblem(host: string) {
    const ghConfig = await resolveGitHubConfig();
    if (host === hostFamily(ghConfig.baseUrl)) {
      return {
        code: 'HOST_IS_INSTANCE',
        message: `${host} is the instance's own GitHub host; its credentials are configured on the GitHub integration, not here`,
      };
    }
    if (!(await approvedRepositoryHosts()).map(hostKeyOf).includes(host)) {
      return {
        code: 'HOST_NOT_APPROVED',
        message: `${host} is neither a configured GitHub host nor listed in github.repositoryHosts`,
      };
    }
    return null;
  }

  // GET /github-host-credentials
  app.get('/github-host-credentials', { onRequest: adminOnly }, async () => {
    const rows = await fastify.prisma.gitHubHostCredential.findMany({ orderBy: { host: 'asc' } });
    return { data: rows.map(present) };
  });

  // POST /github-host-credentials
  app.post(
    '/github-host-credentials',
    { onRequest: adminOnly, schema: { body: CreateSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const { appId, appPrivateKey, token } = request.body;
      // api.github.com and github.com are one host; a row is keyed by the family.
      const host = hostKeyOf(request.body.host);
      if (!(token || appId || appPrivateKey)) {
        return sendError(reply, 400, 'NO_CREDENTIAL', 'Provide a token, a GitHub App, or both');
      }
      if (Boolean(appId) !== Boolean(appPrivateKey)) {
        return sendError(
          reply,
          400,
          'INCOMPLETE_APP',
          'A GitHub App needs both its id and its private key'
        );
      }
      const problem = await hostProblem(host);
      if (problem) {
        return sendError(reply, 400, problem.code, problem.message);
      }
      try {
        const created = await fastify.prisma.gitHubHostCredential.create({
          data: {
            appId: appId ?? null,
            host,
            ...tokenColumns(token ?? null),
            ...keyColumns(appPrivateKey ?? null),
          },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: summary(created),
          entityId: created.id,
          entityType: 'GitHubHostCredential',
        });
        return reply.status(201).send({ data: present(created) });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'HOST_CREDENTIAL_EXISTS',
            `Credentials for ${host} already exist; update them instead`
          );
        }
        throw err;
      }
    }
  );

  // PATCH /github-host-credentials/:id — set, rotate or clear individual fields
  app.patch(
    '/github-host-credentials/:id',
    { onRequest: adminOnly, schema: { body: UpdateSchema, params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.gitHubHostCredential.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return notFound(reply);
      }
      const { appId, appPrivateKey, token } = request.body;
      // What the row will hold: this request's value where it set one.
      const nextToken = token === undefined ? existing.tokenCiphertext !== null : token !== null;
      const nextAppId = appId === undefined ? existing.appId : appId;
      const nextKey =
        appPrivateKey === undefined
          ? existing.appPrivateKeyCiphertext !== null
          : appPrivateKey !== null;
      if (Boolean(nextAppId) !== nextKey) {
        return sendError(
          reply,
          400,
          'INCOMPLETE_APP',
          'A GitHub App needs both its id and its private key; set or clear them together'
        );
      }
      if (!(nextToken || nextAppId)) {
        return sendError(
          reply,
          400,
          'NO_CREDENTIAL',
          'This would leave the host with no credential; delete it instead'
        );
      }
      // An approval that lapsed makes the row inert; editing cannot revive it,
      // so the operator is told rather than left to find out from a failing run.
      const problem = await hostProblem(existing.host);
      if (problem) {
        return sendError(reply, 400, problem.code, problem.message);
      }
      try {
        const updated = await fastify.prisma.gitHubHostCredential.update({
          data: {
            ...(appId !== undefined && { appId }),
            ...(token !== undefined && tokenColumns(token)),
            ...(appPrivateKey !== undefined && keyColumns(appPrivateKey)),
          },
          where: { id: existing.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: summary(updated),
          before: summary(existing),
          entityId: existing.id,
          entityType: 'GitHubHostCredential',
        });
        return { data: present(updated) };
      } catch (err) {
        if (isRecordNotFound(err)) {
          return notFound(reply);
        }
        throw err;
      }
    }
  );

  // DELETE /github-host-credentials/:id
  app.delete(
    '/github-host-credentials/:id',
    { onRequest: adminOnly, schema: { params: IdParams } },
    async (request, reply) => {
      const user = requireUser(request);
      try {
        const deleted = await fastify.prisma.gitHubHostCredential.delete({
          where: { id: request.params.id },
        });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: user,
          before: summary(deleted),
          entityId: deleted.id,
          entityType: 'GitHubHostCredential',
        });
        return reply.status(204).send();
      } catch (err) {
        if (isRecordNotFound(err)) {
          return notFound(reply);
        }
        throw err;
      }
    }
  );
};
