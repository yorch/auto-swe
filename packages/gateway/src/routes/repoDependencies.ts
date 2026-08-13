import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { canManageTeamRepos } from './repositories.js';

/**
 * Repo dependency graph edges (see docs/history/repo-dependency-graph-rfc.md).
 * Mounted under /api/v1/repositories, so the `:id` path param is always the
 * dependent (`from`) repo.
 *
 * Authorization is asymmetric by intent (RFC §4.5): creating/confirming a
 * manual edge needs a LEAD on BOTH the dependent and the depended-upon team —
 * the depended-upon team consents to becoming a context source — while
 * dismissing (the veto) needs the depended-upon team, and removing needs either.
 */

const EdgeKind = z.enum(['code', 'runtime', 'build', 'api', 'data']);

const CreateEdgeSchema = z.object({
  detail: z.record(z.string(), z.unknown()).optional(),
  kind: EdgeKind.default('code'),
  toRepoId: z.string().uuid(),
});

const PatchEdgeSchema = z.object({
  status: z.enum(['active', 'dismissed']),
});

const RepoParams = z.object({ id: z.string().uuid() });
const EdgeParams = z.object({ edgeId: z.string().uuid(), id: z.string().uuid() });

type PrismaClient = FastifyInstance['prisma'];

interface RepoNode {
  id: string;
  teamId: string;
  type: string;
  orgId: string;
  teamActive: boolean;
}

/** Load a connection with the tenancy fields the authz + visibility checks need. */
async function loadRepo(prisma: PrismaClient, id: string): Promise<RepoNode | null> {
  const repo = await prisma.connection.findUnique({
    select: {
      id: true,
      team: { select: { isActive: true, orgId: true } },
      teamId: true,
      type: true,
    },
    where: { id },
  });
  if (!repo?.team) {
    return null;
  }
  return {
    id: repo.id,
    orgId: repo.team.orgId,
    teamActive: repo.team.isActive,
    teamId: repo.teamId,
    type: repo.type,
  };
}

/** Whether the user can see repo `:id` at all — ADMIN, or a member of its team. */
async function canViewRepo(
  prisma: PrismaClient,
  user: { sub: string; role: string },
  repo: RepoNode
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId: repo.teamId, userId: user.sub } },
  });
  return !!membership;
}

export const repoDependencyRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /:id/dependencies — management view: this repo's outgoing edges
  // (depends on) and incoming edges (depended on by), neighbours hydrated and
  // filtered to the caller's org.
  app.get(
    '/:id/dependencies',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }), schema: { params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await loadRepo(fastify.prisma, request.params.id);
      if (!repo || repo.type !== 'git_repo') {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!(await canViewRepo(fastify.prisma, user, repo))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Not a member of this repository’s team' },
        });
      }

      // Edges are not tenant-scoped, so these read freely.
      const [outgoing, incoming] = await Promise.all([
        fastify.prisma.repoDependency.findMany({
          orderBy: { detectedAt: 'desc' },
          where: { fromRepoId: repo.id },
        }),
        fastify.prisma.repoDependency.findMany({
          orderBy: { detectedAt: 'desc' },
          where: { toRepoId: repo.id },
        }),
      ]);

      const neighborIds = [
        ...new Set([
          ...outgoing.map((e) => e.toRepoId).filter((v): v is string => v !== null),
          ...incoming.map((e) => e.fromRepoId),
        ]),
      ];
      const neighbors = neighborIds.length
        ? await fastify.prisma.connection.findMany({
            select: { id: true, name: true, organizationName: true, repoName: true, teamId: true },
            where: { id: { in: neighborIds }, team: { orgId: repo.orgId } },
          })
        : [];
      const byId = new Map(neighbors.map((n) => [n.id, n]));

      const view = (edges: typeof outgoing, neighborKey: 'toRepoId' | 'fromRepoId') =>
        edges.map((e) => {
          const nid = e[neighborKey];
          return {
            confidence: e.confidence,
            detail: e.detail,
            id: e.id,
            kind: e.kind,
            repo: nid ? (byId.get(nid) ?? null) : null,
            source: e.source,
            status: e.status,
            toRef: e.toRef,
          };
        });

      return {
        dependedOnBy: view(incoming, 'fromRepoId'),
        dependsOn: view(outgoing, 'toRepoId'),
      };
    }
  );

  // POST /:id/dependencies — declare a manual edge (both-teams LEAD).
  app.post(
    '/:id/dependencies',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateEdgeSchema, params: RepoParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { toRepoId, kind, detail } = request.body;

      if (request.params.id === toRepoId) {
        return reply.status(400).send({
          error: { code: 'SELF_EDGE', message: 'A repository cannot depend on itself' },
        });
      }

      const [from, to] = await Promise.all([
        loadRepo(fastify.prisma, request.params.id),
        loadRepo(fastify.prisma, toRepoId),
      ]);
      if (!from || from.type !== 'git_repo' || !to || to.type !== 'git_repo') {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (from.orgId !== to.orgId) {
        return reply.status(400).send({
          error: {
            code: 'CROSS_ORG_EDGE',
            message: 'Dependency edges cannot cross an organization boundary',
          },
        });
      }

      const [canFrom, canTo] = await Promise.all([
        canManageTeamRepos(fastify.prisma, user, from.teamId),
        canManageTeamRepos(fastify.prisma, user, to.teamId),
      ]);
      if (!canFrom || !canTo) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires LEAD on both the dependent and the depended-upon repository’s team',
          },
        });
      }

      try {
        const edge = await fastify.prisma.repoDependency.create({
          data: {
            confidence: 1,
            confirmedAt: new Date(),
            confirmedById: user.sub,
            detail: (detail ?? undefined) as never,
            fromRepoId: from.id,
            kind,
            source: 'manual',
            status: 'active',
            toRepoId: to.id,
          },
        });
        return reply.status(201).send(edge);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.status(409).send({
            error: { code: 'EDGE_EXISTS', message: 'That dependency edge already exists' },
          });
        }
        throw err;
      }
    }
  );

  // PATCH /:id/dependencies/:edgeId — confirm (→active) or dismiss (veto).
  app.patch(
    '/:id/dependencies/:edgeId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: PatchEdgeSchema, params: EdgeParams },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const edge = await fastify.prisma.repoDependency.findUnique({
        where: { id: request.params.edgeId },
      });
      if (!edge || edge.fromRepoId !== request.params.id) {
        return reply.status(404).send({
          error: { code: 'EDGE_NOT_FOUND', message: 'Dependency edge not found' },
        });
      }

      const from = await loadRepo(fastify.prisma, edge.fromRepoId);
      const to = edge.toRepoId ? await loadRepo(fastify.prisma, edge.toRepoId) : null;
      if (!from) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }

      if (request.body.status === 'active') {
        // Confirm / reactivate is a human claim of a relationship → both teams.
        if (!to) {
          return reply.status(400).send({
            error: {
              code: 'UNRESOLVED_EDGE',
              message:
                'An unresolved suggestion cannot be activated until its repository is onboarded',
            },
          });
        }
        const [canFrom, canTo] = await Promise.all([
          canManageTeamRepos(fastify.prisma, user, from.teamId),
          canManageTeamRepos(fastify.prisma, user, to.teamId),
        ]);
        if (!canFrom || !canTo) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Requires LEAD on both teams to activate an edge',
            },
          });
        }
        return fastify.prisma.repoDependency.update({
          data: {
            confirmedAt: new Date(),
            confirmedById: user.sub,
            dismissedAt: null,
            dismissedById: null,
            status: 'active',
          },
          where: { id: edge.id },
        });
      }

      // Dismiss is the depended-upon team's veto. For a resolved edge that is the
      // `to` team; for an unresolved suggestion there is no `to` team, so the
      // dependent team's LEAD manages it.
      const vetoTeamId = to?.teamId ?? from.teamId;
      if (!(await canManageTeamRepos(fastify.prisma, user, vetoTeamId))) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Requires LEAD on the depended-upon repository’s team to dismiss',
          },
        });
      }
      return fastify.prisma.repoDependency.update({
        data: { dismissedAt: new Date(), dismissedById: user.sub, status: 'dismissed' },
        where: { id: edge.id },
      });
    }
  );

  // DELETE /:id/dependencies/:edgeId — remove (either team's LEAD).
  app.delete(
    '/:id/dependencies/:edgeId',
    { onRequest: requireAuth({ requiredRole: 'LEAD' }), schema: { params: EdgeParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const edge = await fastify.prisma.repoDependency.findUnique({
        where: { id: request.params.edgeId },
      });
      if (!edge || edge.fromRepoId !== request.params.id) {
        return reply.status(404).send({
          error: { code: 'EDGE_NOT_FOUND', message: 'Dependency edge not found' },
        });
      }
      const from = await loadRepo(fastify.prisma, edge.fromRepoId);
      const to = edge.toRepoId ? await loadRepo(fastify.prisma, edge.toRepoId) : null;
      const teamIds = [from?.teamId, to?.teamId].filter((v): v is string => !!v);
      const allowed = (
        await Promise.all(teamIds.map((t) => canManageTeamRepos(fastify.prisma, user, t)))
      ).some(Boolean);
      if (user.role !== 'ADMIN' && !allowed) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Requires LEAD on either repository’s team' },
        });
      }
      await fastify.prisma.repoDependency.delete({ where: { id: edge.id } });
      return reply.status(204).send();
    }
  );
};
