/**
 * A user's own GitHub token for a repository.
 *
 * Every route here acts on the caller's own credential and nobody else's:
 * there is no route that reads, lists or deletes another user's token, ADMIN
 * included. An admin who wants a token gone deletes the user or the
 * repository — both cascade — and an admin who wants these unused turns off
 * `github.userCredentialsEnabled`.
 *
 * Saving is refused unless the feature is on, the repository's hosts are on the
 * admin's allowlist, and GitHub confirms the token can write to the repository.
 * Removing is always allowed, feature on or off, so a user is never stuck with a
 * secret they want gone.
 */
import {
  credentialHostAllowed,
  encryptCredentialToken,
  originOf,
  resolveUserCredentialPolicy,
} from '@auto-swe/shared/lib/connectionCredential';
import { fetchOwnRepoPermission, permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import { recordRepoPermission } from '@auto-swe/shared/lib/repoAccessProjection';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const SaveSchema = z.object({
  // No whitespace anywhere: the token goes into an Authorization header and a
  // clone URL, and a pasted trailing newline is the common way to break both.
  token: z.string().trim().min(1).max(1000).regex(/^\S+$/, 'must not contain whitespace'),
});

export const connectionCredentialRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const signedIn = requireAuth({ requiredRole: 'ENGINEER' });

  /**
   * The repository a credential route acts on, if the caller may hold a token
   * for it: an active `git_repo` in a team they belong to. ADMINs pass the
   * membership test, consistent with every other repository route.
   */
  async function loadOwnableRepo(id: string, user: { sub: string; role: string }) {
    const repo = await fastify.prisma.connection.findUnique({
      select: {
        githubApiUrl: true,
        githubUrl: true,
        id: true,
        isActive: true,
        organizationName: true,
        repoName: true,
        team: {
          select: {
            isActive: true,
            memberships: { select: { userId: true }, where: { userId: user.sub } },
          },
        },
        type: true,
      },
      where: { id },
    });
    if (repo?.type !== 'git_repo' || !(repo.organizationName && repo.repoName)) {
      return null;
    }
    if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
      return null;
    }
    return repo;
  }

  // GET /api/v1/repositories/credentials/mine — the policy plus which
  // repositories the caller has saved a token for. One call drives the whole
  // Connections page; the token itself is never returned.
  app.get('/credentials/mine', { onRequest: signedIn }, async (request) => {
    const user = requireUser(request);
    const [policy, rows] = await Promise.all([
      resolveUserCredentialPolicy(),
      fastify.prisma.connectionCredential.findMany({
        select: { connectionId: true, createdAt: true, tokenLastFour: true, updatedAt: true },
        where: { userId: user.sub },
      }),
    ]);
    return {
      data: {
        credentials: rows.map((r) => ({
          connectionId: r.connectionId,
          createdAt: r.createdAt,
          lastFour: r.tokenLastFour,
          updatedAt: r.updatedAt,
        })),
        enabled: policy.enabled,
        hosts: policy.hosts,
      },
    };
  });

  // PUT /api/v1/repositories/:id/credential — save (or replace) the caller's
  // own token for this repository, after GitHub confirms it can write there.
  app.put(
    '/:id/credential',
    { onRequest: signedIn, schema: { body: SaveSchema, params: ParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const policy = await resolveUserCredentialPolicy();
      if (!policy.enabled) {
        return reply.status(403).send({
          error: {
            code: 'USER_CREDENTIALS_DISABLED',
            message: 'Per-user GitHub credentials are turned off on this platform.',
          },
        });
      }

      const repo = await loadOwnableRepo(request.params.id, user);
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!(repo.isActive && repo.team.isActive)) {
        return reply.status(409).send({
          error: { code: 'REPO_INACTIVE', message: 'This repository or its team is inactive.' },
        });
      }

      // Both hosts, because a run sends the token to both: the web base for
      // the clone, the API base for everything else.
      const ghConfig = await resolveGitHubConfig();
      const apiUrl = repo.githubApiUrl ?? ghConfig.apiUrl;
      const baseUrl = repo.githubUrl ?? ghConfig.baseUrl;
      const refused = [apiUrl, baseUrl].filter((u) => !credentialHostAllowed(u, policy.hosts));
      if (refused.length > 0) {
        return reply.status(400).send({
          error: {
            code: 'HOST_NOT_ALLOWED',
            message: `Personal tokens may not be sent to ${refused.join(' or ')}. An admin can allow the host under the GitHub platform settings.`,
          },
        });
      }

      const { token } = request.body;
      const lookup = await fetchOwnRepoPermission({
        apiUrl,
        organizationName: repo.organizationName as string,
        repoName: repo.repoName as string,
        token,
      });
      if (!lookup.ok) {
        if (lookup.failure === 'credential-rejected' || lookup.failure === 'repo-not-found') {
          return reply.status(400).send({
            error: {
              code: 'CREDENTIAL_REJECTED',
              message: `GitHub rejected this token, or it cannot see ${repo.organizationName}/${repo.repoName}. Check that it has access to the repository.`,
            },
          });
        }
        return reply.status(503).send({
          error: {
            code: 'GITHUB_UNAVAILABLE',
            message: 'GitHub could not be reached to verify the token. Try again shortly.',
          },
        });
      }
      // A run pushes a branch and opens a pull request, so a token whose owner
      // can only read would be saved only to fail every run later.
      if (!permissionMeets(lookup.permission, 'write')) {
        return reply.status(400).send({
          error: {
            code: 'INSUFFICIENT_PERMISSION',
            message: `This token's account has ${lookup.permission} access to ${repo.organizationName}/${repo.repoName}; runs need write access.`,
          },
        });
      }

      const key = { connectionId: repo.id, userId: user.sub };
      // Bound to where it was just verified: if a lead later repoints the
      // repository, the token stops being used instead of following it.
      const encrypted = {
        ...encryptCredentialToken(token),
        apiOrigin: originOf(apiUrl) as string,
        webOrigin: originOf(baseUrl) as string,
      };
      const existing = await fastify.prisma.connectionCredential.findUnique({
        select: { id: true, tokenLastFour: true },
        where: { connectionId_userId: key },
      });
      // A plain (non-partial) unique index, so upsert is safe here — unlike the
      // per-scope partial indexes on Agent and ProviderCredential.
      const saved = await fastify.prisma.connectionCredential.upsert({
        create: { ...key, ...encrypted },
        select: { createdAt: true, id: true, tokenLastFour: true, updatedAt: true },
        update: encrypted,
        where: { connectionId_userId: key },
      });

      // The verification was a real answer from GitHub about the identity this
      // user's runs will act as, so it goes into the projection like any other.
      await recordRepoPermission(fastify.prisma, { ...key, lookup });

      await writeAuditLog(fastify, {
        action: existing ? 'UPDATE' : 'CREATE',
        actor: user,
        after: { ...key, lastFour: saved.tokenLastFour },
        before: existing ? { ...key, lastFour: existing.tokenLastFour } : undefined,
        entityId: saved.id,
        entityType: 'ConnectionCredential',
      });

      return reply.status(existing ? 200 : 201).send({
        data: {
          connectionId: repo.id,
          createdAt: saved.createdAt,
          lastFour: saved.tokenLastFour,
          permission: lookup.permission,
          updatedAt: saved.updatedAt,
        },
      });
    }
  );

  // DELETE /api/v1/repositories/:id/credential — remove the caller's own token.
  // Allowed whether or not the feature is on, and without the membership check:
  // a user who has left the team must still be able to take their secret back.
  app.delete(
    '/:id/credential',
    { onRequest: signedIn, schema: { params: ParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const key = { connectionId: request.params.id, userId: user.sub };
      const existing = await fastify.prisma.connectionCredential.findUnique({
        select: { id: true, tokenLastFour: true },
        where: { connectionId_userId: key },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'CREDENTIAL_NOT_FOUND', message: 'No saved token for this repository' },
        });
      }
      await fastify.prisma.connectionCredential.delete({ where: { id: existing.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: user,
        before: { ...key, lastFour: existing.tokenLastFour },
        entityId: existing.id,
        entityType: 'ConnectionCredential',
      });
      return reply.status(204).send();
    }
  );
};
