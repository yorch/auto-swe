import { EDGE_KINDS } from '@auto-swe/shared/lib/repoDependency';
import { NEIGHBOR_SELECT } from '@auto-swe/shared/lib/repoDependencyResolver';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { requireAuth, requireUser } from '../plugins/auth.js';
import { canManageTeamRepos } from './repositories.js';

/**
 * Repo dependency graph edges (see docs/history/repo-dependency-graph-rfc.md).
 * Mounted under /api/v1/repositories. `:id` is a repo the edge touches — the
 * `from` (dependent) repo for the "Depends on" view, or the `to` (depended-upon)
 * repo when its team manages an incoming edge from its own "Depended on by" view.
 *
 * Authorization is asymmetric by intent (RFC §4.5): creating/confirming a
 * manual edge needs a LEAD on BOTH the dependent and the depended-upon team —
 * the depended-upon team consents to becoming a context source — while
 * dismissing (the veto) needs the depended-upon team, and removing needs either.
 */

const CreateEdgeSchema = z.object({
  detail: z.record(z.string(), z.unknown()).optional(),
  kind: z.enum(EDGE_KINDS).default('code'),
  toRepoId: z.string().uuid(),
});

const PatchEdgeSchema = z.object({
  status: z.enum(['active', 'dismissed']),
});

const RepoParams = z.object({ id: z.string().uuid() });
const EdgeParams = z.object({ edgeId: z.string().uuid(), id: z.string().uuid() });

type RoutePrisma = FastifyInstance['prisma'];

interface RepoNode {
  id: string;
  teamId: string;
  type: string;
  orgId: string;
}

/** Load a connection with the tenancy fields the authz + visibility checks need. */
async function loadRepo(prisma: RoutePrisma, id: string): Promise<RepoNode | null> {
  const repo = await prisma.connection.findUnique({
    select: { id: true, team: { select: { orgId: true } }, teamId: true, type: true },
    where: { id },
  });
  if (!repo?.team) {
    return null;
  }
  return { id: repo.id, orgId: repo.team.orgId, teamId: repo.teamId, type: repo.type };
}

/** Whether the edge touches repo `id` as either endpoint. */
function edgeInvolves(edge: { fromRepoId: string; toRepoId: string | null }, id: string): boolean {
  return edge.fromRepoId === id || edge.toRepoId === id;
}

/**
 * Load an edge and both its endpoint repos, scoped so `:id` must be one of them.
 * Returns null when the edge is missing or does not involve `:id` (→ 404). The
 * two repo loads run in parallel; `to` is null for an unresolved suggestion.
 */
async function loadEdgeWithRepos(prisma: RoutePrisma, edgeId: string, id: string) {
  const edge = await prisma.repoDependency.findUnique({ where: { id: edgeId } });
  if (!edge || !edgeInvolves(edge, id)) {
    return null;
  }
  const [from, to] = await Promise.all([
    loadRepo(prisma, edge.fromRepoId),
    edge.toRepoId ? loadRepo(prisma, edge.toRepoId) : Promise.resolve(null),
  ]);
  return { edge, from, to };
}

/** Whether the user is a LEAD (or ADMIN) on both teams — the manual-edge gate. */
async function bothTeamsLead(
  prisma: RoutePrisma,
  user: { sub: string; role: string },
  teamA: string,
  teamB: string
): Promise<boolean> {
  const [a, b] = await Promise.all([
    canManageTeamRepos(prisma, user, teamA),
    canManageTeamRepos(prisma, user, teamB),
  ]);
  return a && b;
}

/** Whether the user can see repo `:id` at all — ADMIN, or a member of its team. */
async function canViewRepo(
  prisma: RoutePrisma,
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

  // GET /dependencies/unresolved — onboarding suggestions.
  //
  // A detector records a dependency it could not resolve to a registered repo as
  // an `unresolved` row carrying the raw ref. Grouping those by ref answers "which
  // repo should we onboard next, and who is waiting on it". Declared before the
  // `/:id/...` routes so the literal path is unambiguous.
  app.get(
    '/dependencies/unresolved',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request) => {
      const user = requireUser(request);
      // The ADMIN branch below drops the membership predicate deliberately.
      // Written bare it would read as a forgotten filter — the exact bug the
      // tenant guard exists to catch — so mark it as an intentional
      // cross-tenant read instead.
      const rows = await asPlatformAdmin(
        user,
        'an admin triages onboarding suggestions across every team',
        ['RepoDependency', 'Connection'],
        () =>
          fastify.prisma.repoDependency.findMany({
            orderBy: { detectedAt: 'desc' },
            select: {
              confidence: true,
              fromRepo: { select: NEIGHBOR_SELECT },
              id: true,
              kind: true,
              source: true,
              toRef: true,
            },
            // Suggestions are only actionable to someone who can see the repo that
            // raised them, so non-admins see their own teams' rows only.
            take: 500,
            where: {
              status: 'unresolved',
              toRef: { not: null },
              ...(user.role !== 'ADMIN' && {
                fromRepo: { team: { memberships: { some: { userId: user.sub } } } },
              }),
            },
          })
      );

      // Returned flat, one row per unresolved edge: the client component owns the
      // grouping by `toRef` (and is unit-tested on it), so duplicating that here
      // would be two implementations of the same rule.
      return { data: rows };
    }
  );

  // POST /dependencies/scan — run the detector sweep now, out of schedule band.
  // Restricted to ADMIN: the sweep spans every team's repos, not just the
  // caller's, and writes edges across the whole deployment.
  app.post(
    '/dependencies/scan',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }) },
    async (_request, reply) => {
      try {
        await fastify.temporal.triggerRepoDependencyScanNow();
        return { triggered: true };
      } catch {
        // The handle only exists once the schedule has been synced.
        return reply.status(503).send({
          error: {
            code: 'SCHEDULE_UNAVAILABLE',
            message: 'The repo dependency scan schedule is not registered yet.',
          },
        });
      }
    }
  );

  // POST /:id/dependencies/infer — ask the inference agent for likely edges.
  //
  // Costs a model call, so it is per-repo and opt-in rather than part of the free
  // scheduled sweep. Findings land as `proposed` (or auto-promoted above the
  // configured confidence threshold), never straight into agent context.
  app.post(
    '/:id/dependencies/infer',
    { onRequest: requireAuth({ requiredRole: 'LEAD' }), schema: { params: RepoParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await loadRepo(fastify.prisma, request.params.id);
      if (!repo || repo.type !== 'git_repo') {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Requires LEAD on this repository’s team' },
        });
      }
      await fastify.temporal.startRepoDependencyInference(`repo-dep-infer-${repo.id}`, repo.id);
      return reply.status(202).send({ started: true });
    }
  );

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
      // Reuse the resolver's neighbour select; the visibility predicate is kept
      // literal (mirrors resolveRepoDependencyContext) so tenantGuard's static
      // scanner can see the team.orgId filter.
      const neighbors = neighborIds.length
        ? await fastify.prisma.connection.findMany({
            select: NEIGHBOR_SELECT,
            where: {
              id: { in: neighborIds },
              isActive: true,
              team: { orgId: repo.orgId },
              type: 'git_repo',
            },
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

      if (!(await bothTeamsLead(fastify.prisma, user, from.teamId, to.teamId))) {
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
      // `:id` may be the `from` or the `to` repo — the depended-upon team
      // dismisses incoming edges from its own repo's modal (RFC §4.5).
      const loaded = await loadEdgeWithRepos(
        fastify.prisma,
        request.params.edgeId,
        request.params.id
      );
      if (!loaded) {
        return reply.status(404).send({
          error: { code: 'EDGE_NOT_FOUND', message: 'Dependency edge not found' },
        });
      }
      const { edge, from, to } = loaded;
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
        if (!(await bothTeamsLead(fastify.prisma, user, from.teamId, to.teamId))) {
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
      if (!edge || !edgeInvolves(edge, request.params.id)) {
        return reply.status(404).send({
          error: { code: 'EDGE_NOT_FOUND', message: 'Dependency edge not found' },
        });
      }
      // ADMIN removes any edge; others need LEAD on either endpoint's team — so
      // only load the endpoint repos when we actually have to check membership.
      if (user.role !== 'ADMIN') {
        const [from, to] = await Promise.all([
          loadRepo(fastify.prisma, edge.fromRepoId),
          edge.toRepoId ? loadRepo(fastify.prisma, edge.toRepoId) : Promise.resolve(null),
        ]);
        const teamIds = [from?.teamId, to?.teamId].filter((v): v is string => !!v);
        const allowed = (
          await Promise.all(teamIds.map((t) => canManageTeamRepos(fastify.prisma, user, t)))
        ).some(Boolean);
        if (!allowed) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Requires LEAD on either repository’s team' },
          });
        }
      }
      await fastify.prisma.repoDependency.delete({ where: { id: edge.id } });
      return reply.status(204).send();
    }
  );
};
