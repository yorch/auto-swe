import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { fetchGitHubAppIdentity } from '@auto-swe/shared/lib/githubInstallation';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { verifyGithubInstaller } from '../lib/githubConnect.js';
import { signGithubConnectState, verifyGithubConnectState } from '../lib/githubConnectState.js';
import { sendError } from '../lib/httpErrors.js';
import { isOrgAdmin } from '../lib/orgAccess.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const OrgParams = z.object({ orgId: z.string().uuid() });
const InstallationParams = OrgParams.extend({ id: z.string().uuid() });
const Claim = z
  .object({
    code: z.string().min(1).max(500),
    installation_id: z.string().regex(/^\d{1,64}$/),
    state: z.string().min(1).max(4096),
  })
  .strict();

export const organizationGithubRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = requireAuth({ requiredRole: 'ENGINEER' });
  async function appConfig() {
    const config = await resolveGitHubConfig();
    if (!(config.appId && config.appPrivateKey && config.appClientId && config.appClientSecret)) {
      return null;
    }
    if (
      hostFamily(config.baseUrl) !== hostFamily(config.apiUrl) ||
      !config.baseUrl.startsWith('https://') ||
      !config.apiUrl.startsWith('https://')
    ) {
      return null;
    }
    const identity = await fetchGitHubAppIdentity({
      apiUrl: config.apiUrl,
      appId: config.appId,
      privateKey: config.appPrivateKey,
    });
    return identity.ok &&
      identity.id === config.appId &&
      /^[a-z0-9][a-z0-9-]{0,99}$/.test(identity.slug)
      ? { config, slug: identity.slug }
      : null;
  }

  app.post(
    '/organizations/:orgId/github/connect',
    { onRequest: auth, schema: { params: OrgParams } },
    async (request, reply) => {
      const user = requireUser(request);
      if (!(await isOrgAdmin(fastify.prisma, user, request.params.orgId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires organization admin');
      }
      const settings = await appConfig();
      if (!settings) {
        return sendError(
          reply,
          409,
          'GITHUB_CONNECT_NOT_CONFIGURED',
          'A platform admin must configure the instance App slug, client credentials and OAuth during installation.'
        );
      }
      const { config, slug } = settings;
      const state = signGithubConnectState({
        appId: config.appId as string,
        host: config.apiUrl,
        orgId: request.params.orgId,
        userId: user.sub,
      });
      return {
        data: {
          url: `${config.baseUrl.replace(/\/$/, '')}/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
        },
      };
    }
  );

  app.post(
    '/organizations/github/claim',
    { onRequest: auth, schema: { body: Claim } },
    async (request, reply) => {
      const user = requireUser(request);
      const claims = verifyGithubConnectState(request.body.state);
      if (!claims || claims.userId !== user.sub) {
        return sendError(
          reply,
          400,
          'INVALID_STATE',
          'The connection request is invalid or expired. Start again from your organization.'
        );
      }
      if (!(await isOrgAdmin(fastify.prisma, user, claims.orgId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires organization admin');
      }
      const settings = await appConfig();
      if (!settings) {
        return sendError(
          reply,
          409,
          'GITHUB_CONNECT_NOT_CONFIGURED',
          'The instance App is not configured for organization connections.'
        );
      }
      if (claims.appId !== settings.config.appId || claims.host !== settings.config.apiUrl) {
        return sendError(reply, 400, 'INVALID_STATE', 'The instance App changed. Start again.');
      }
      const installationId = request.body.installation_id;
      const existing = await fastify.prisma.gitHubInstallation.findUnique({
        where: { host_installationId: { host: '', installationId } },
      });
      if (existing) {
        return sendError(
          reply,
          409,
          'INSTALLATION_EXISTS',
          'This installation is already registered. A platform admin manages its organization link.'
        );
      }
      let accountLogin: string | null;
      try {
        accountLogin = await verifyGithubInstaller(
          settings.config,
          request.body.code,
          installationId
        );
      } catch {
        return sendError(
          reply,
          502,
          'GITHUB_AUTHORIZATION_FAILED',
          'GitHub could not verify this installation. Start again from your organization.'
        );
      }
      if (!accountLogin) {
        return sendError(
          reply,
          403,
          'INSTALLATION_UNVERIFIED',
          'GitHub did not confirm this installation for the authorizing user.'
        );
      }
      try {
        const row = await fastify.prisma.$transaction(async (tx) => {
          const created = await tx.gitHubInstallation.create({
            data: { accountLogin, host: '', installationId, organizationId: claims.orgId },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: { accountLogin, installationId, organizationId: claims.orgId },
            client: tx,
            entityId: created.id,
            entityType: 'GitHubInstallation',
          });
          return created;
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendError(
            reply,
            409,
            'INSTALLATION_EXISTS',
            'This installation is already registered.'
          );
        }
        throw err;
      }
    }
  );

  app.get(
    '/organizations/:orgId/github/installations',
    { onRequest: auth, schema: { params: OrgParams } },
    async (request, reply) => {
      if (!(await isOrgAdmin(fastify.prisma, requireUser(request), request.params.orgId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires organization admin');
      }
      return {
        data: await fastify.prisma.gitHubInstallation.findMany({
          orderBy: { accountLogin: 'asc' },
          where: { organizationId: request.params.orgId },
        }),
      };
    }
  );

  app.post(
    '/organizations/:orgId/github/installations/:id/retire',
    { onRequest: auth, schema: { params: InstallationParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { orgId, id } = request.params;
      if (!(await isOrgAdmin(fastify.prisma, user, orgId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires organization admin');
      }
      const row = await fastify.prisma.gitHubInstallation.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!row) {
        return sendError(reply, 404, 'INSTALLATION_NOT_FOUND', 'Installation not found');
      }
      await fastify.prisma.$transaction(async (tx) => {
        await tx.gitHubInstallation.updateMany({
          data: { isActive: false, retiredReason: null },
          where: { id, organizationId: orgId },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { isActive: false, retiredReason: null },
          before: { isActive: row.isActive },
          client: tx,
          entityId: id,
          entityType: 'GitHubInstallation',
        });
      });
      return { data: { retired: true } };
    }
  );
};
