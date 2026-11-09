import { createHash } from 'node:crypto';
import { Role } from '@auto-swe/shared';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import {
  OnboardingRequestSchema,
  onboardingPrWorkflowId,
  renderOnboardingFiles,
} from '@auto-swe/shared/lib/onboardingPr';
import {
  resolveToolRequests,
  type ToolCatalogEntry,
  ToolInstallError,
  type ToolRequest,
  toToolCatalogEntry,
} from '@auto-swe/shared/lib/toolCatalog';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { isTemporalUnavailable, sendTemporalUnavailable } from '../lib/temporalErrors.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { canManageTeamRepos } from './repositories.js';

/**
 * Ask the platform to open a pull request that adds a repository's `.auto-swe/` config files
 * (`tools.yml`, `pr-policy.yml`). The request is structured data, never a path or file body: the
 * files and their paths are rendered by `renderOnboardingFiles`, so this cannot write anywhere
 * else. Proposing is management of the repository, so it is the owning team's (a team the
 * repository is merely shared with cannot); reading a run's outcome is any owning-team member's.
 */

const RepoParams = z.object({ id: z.string().uuid() });
const RunParams = z.object({
  id: z.string().uuid(),
  workflowId: z.string().min(1).max(128),
});

/** The first 16 hex digits of a sha256 over the sorted `path\0content` pairs. */
export function contentHashOf(files: readonly { path: string; content: string }[]): string {
  const canonical = files
    .map((f) => `${f.path}\0${f.content}`)
    .sort()
    .join('\0\0');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** The requested tools the catalog cannot supply, with why. Empty when every one resolves. */
async function unavailableTools(
  fastify: FastifyInstance,
  requests: readonly ToolRequest[]
): Promise<{ key: string; version?: string; reason: 'unknown' | 'revoked' }[]> {
  const rows = await fastify.prisma.toolCatalogEntry.findMany({
    where: { key: { in: requests.map((r) => r.key) } },
  });
  const catalog: ToolCatalogEntry[] = [];
  for (const row of rows) {
    try {
      catalog.push(toToolCatalogEntry(row));
    } catch {
      // A row that does not validate is never installable, so it is as good as absent.
    }
  }
  const refused: { key: string; version?: string; reason: 'unknown' | 'revoked' }[] = [];
  for (const request of requests) {
    try {
      resolveToolRequests([request], catalog);
    } catch (err) {
      if (!(err instanceof ToolInstallError)) {
        throw err;
      }
      refused.push({
        key: request.key,
        ...(request.version ? { version: request.version } : {}),
        reason: err.message.includes('is revoked') ? 'revoked' : 'unknown',
      });
    }
  }
  return refused;
}

export const repositoryOnboardingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/v1/repositories/:id/onboarding-pr
  app.post(
    '/repositories/:id/onboarding-pr',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: OnboardingRequestSchema, params: RepoParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      // Reachability before management: a repository the caller cannot reach is not found.
      const repo = await fastify.prisma.connection.findFirst({
        select: {
          githubApiUrl: true,
          githubUrl: true,
          id: true,
          isActive: true,
          teamId: true,
          type: true,
        },
        where: {
          id: request.params.id,
          ...(user.role === Role.ADMIN ? {} : reachableConnections(user, request.repoAccessGate)),
        },
      });
      if (!repo) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
      }
      if (repo.type !== 'git_repo') {
        return sendError(reply, 400, 'NOT_A_GIT_REPO', 'Only a git repository can be onboarded');
      }
      if (!repo.isActive) {
        return sendError(reply, 400, 'REPO_INACTIVE', 'The repository is not active');
      }
      const hosts = await repositoryHostsAllowed({
        githubApiUrl: repo.githubApiUrl,
        githubUrl: repo.githubUrl,
      });
      if (!hosts.ok) {
        return sendError(
          reply,
          400,
          'REPO_HOST_NOT_ALLOWED',
          'The repository is on a host that is not approved for platform credentials'
        );
      }

      const toolsFile = request.body.files.find((f) => f.kind === 'tools');
      if (toolsFile?.kind === 'tools') {
        const refused = await unavailableTools(fastify, toolsFile.tools);
        if (refused.length > 0) {
          const revoked = refused.some((r) => r.reason === 'revoked');
          return sendError(
            reply,
            400,
            revoked ? 'TOOL_REVOKED' : 'UNKNOWN_TOOL',
            `Tools not available from the tool catalog: ${refused
              .map((r) => `${r.key}${r.version ? `@${r.version}` : ''} (${r.reason})`)
              .join(', ')}`,
            { tools: refused }
          );
        }
      }

      let rendered: ReturnType<typeof renderOnboardingFiles>;
      try {
        rendered = renderOnboardingFiles(request.body);
      } catch {
        return sendError(
          reply,
          400,
          'ONBOARDING_RENDER_FAILED',
          'The requested files cannot be rendered'
        );
      }
      const contentHash = contentHashOf(rendered);
      const workflowId = onboardingPrWorkflowId(repo.id, contentHash);
      try {
        await fastify.temporal.startOnboardingPrWorkflow(workflowId, {
          connectionId: repo.id,
          contentHash,
          files: request.body.files,
          proposedById: user.sub,
        });
      } catch (err) {
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        throw err;
      }

      // After the start, and not fatal: the run is already going and cannot be taken back, so a
      // failing audit write is logged and the caller still gets the 202 (a retry would find the
      // same deterministic workflow id and join it rather than start a second run).
      try {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: {
            onboardingPr: {
              files: request.body.files.map((f) => f.kind),
              paths: rendered.map((f) => f.path),
              tools: toolsFile?.kind === 'tools' ? toolsFile.tools : [],
              workflowId,
            },
          },
          entityId: repo.id,
          entityType: 'Connection',
        });
      } catch (err) {
        request.log.error(
          { err, repositoryId: repo.id, workflowId },
          'onboarding pull request started but its audit entry could not be written'
        );
      }

      return reply.status(202).send({ data: { files: rendered.map((f) => f.path), workflowId } });
    }
  );

  // GET /api/v1/repositories/:id/onboarding-pr/:workflowId
  app.get(
    '/repositories/:id/onboarding-pr/:workflowId',
    {
      onRequest: requireAuth(),
      schema: { params: RunParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, workflowId } = request.params;
      const repo = await fastify.prisma.connection.findFirst({
        select: { id: true, teamId: true },
        where: {
          id,
          type: 'git_repo',
          ...(user.role === Role.ADMIN ? {} : reachableConnections(user, request.repoAccessGate)),
        },
      });
      if (!repo) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (user.role !== Role.ADMIN) {
        const membership = await fastify.prisma.teamMembership.findUnique({
          where: { userId_teamId: { teamId: repo.teamId, userId: user.sub } },
        });
        if (!membership) {
          return sendError(
            reply,
            403,
            'FORBIDDEN',
            "Requires membership of this repository's team"
          );
        }
      }
      // A run belongs to the repository its id names, so one repository cannot read another's.
      if (!workflowId.startsWith(`onboard-${repo.id}-`)) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Onboarding run not found');
      }
      let status: Awaited<ReturnType<typeof fastify.temporal.getOnboardingPrStatus>>;
      try {
        status = await fastify.temporal.getOnboardingPrStatus(workflowId);
      } catch (err) {
        if (isTemporalUnavailable(err)) {
          return sendTemporalUnavailable(reply);
        }
        throw err;
      }
      if (!status) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Onboarding run not found');
      }
      return { data: status };
    }
  );
};
