import type { Prisma } from '@auto-swe/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hasRole, requireAuth, requireUser } from '../plugins/auth.js';

const CreateRepoSchema = z.object({
  defaultBranch: z.string().default('main'),
  description: z.string().optional(),
  executorImage: z.string().optional(),
  githubApiUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  language: z.string().optional(),
  mcpServerRef: z.string().optional(),
  organizationName: z.string().min(1),
  repoName: z.string().min(1),
  teamId: z.string().uuid(),
});

const RepoParamsSchema = z.object({ id: z.string().uuid() });

const UpdateRepoSchema = z.object({
  consolidationEnabled: z.boolean().optional(),
  defaultBranch: z.string().optional(),
  description: z.string().nullable().optional(),
  executorImage: z.string().nullable().optional(),
  githubApiUrl: z.string().url().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  language: z.string().nullable().optional(),
  mcpServerRef: z.string().nullable().optional(),
  teamId: z.string().uuid().optional(),
});

/**
 * Whether a user may manage repositories owned by `teamId`. Platform ADMINs can
 * manage any team's repos; everyone else must be a LEAD (or higher) member of
 * that specific team AND the team must be active. The route-level
 * `requiredRole: 'LEAD'` gate only checks the *platform* role, so this
 * team-scoped check is what stops a LEAD on team A from onboarding/reassigning
 * repos into team B — and the isActive check keeps it consistent with the
 * create path (a LEAD of a deactivated team can't keep editing its repos).
 */
async function canManageTeamRepos(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string },
  teamId: string
): Promise<boolean> {
  if (user.role === 'ADMIN') {
    return true;
  }
  const membership = await prisma.teamMembership.findUnique({
    include: { team: { select: { isActive: true } } },
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  return !!membership && membership.team.isActive && hasRole(membership.role, 'LEAD');
}

export const repositoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/repositories — List repositories
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.ConnectionWhereInput = {
        isActive: true,
        ...(user.role !== 'ADMIN' && {
          team: { memberships: { some: { userId: user.sub } } },
        }),
      };

      const repos = await fastify.prisma.connection.findMany({
        include: {
          _count: { select: { activeWorkflows: true } },
          team: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { repoName: 'asc' },
        where,
      });

      return { data: repos };
    }
  );

  // POST /api/v1/repositories — Onboard repository
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateRepoSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { organizationName, repoName, teamId, ...rest } = request.body;

      // Verify team exists
      const team = await fastify.prisma.team.findUnique({ where: { id: teamId } });
      if (!team?.isActive) {
        return reply.status(404).send({
          error: { code: 'TEAM_NOT_FOUND', message: 'Team not found or inactive' },
        });
      }

      // Non-admins may only onboard repos into teams they lead.
      if (!(await canManageTeamRepos(fastify.prisma, user, teamId))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Requires LEAD role in the target team' },
        });
      }

      // Check for duplicate
      const existing = await fastify.prisma.connection.findUnique({
        where: { organizationName_repoName: { organizationName, repoName } },
      });
      if (existing) {
        return reply.status(409).send({
          error: { code: 'REPO_EXISTS', message: 'Repository already onboarded' },
        });
      }

      const repo = await fastify.prisma.connection.create({
        data: { organizationName, repoName, teamId, ...rest },
        include: { team: { select: { id: true, name: true, slug: true } } },
      });

      return reply.status(201).send({ data: repo });
    }
  );

  // PATCH /api/v1/repositories/:id — Update repository config
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: UpdateRepoSchema, params: RepoParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await fastify.prisma.connection.findUnique({
        where: { id: request.params.id },
      });
      if (!repo) {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }

      // Non-admins must lead the repo's current team to edit it...
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: "Requires LEAD role in this repository's team" },
        });
      }
      // ...and, when reassigning to a different team, also lead the destination.
      const newTeamId = request.body.teamId;
      if (newTeamId && newTeamId !== repo.teamId) {
        const destTeam = await fastify.prisma.team.findUnique({ where: { id: newTeamId } });
        if (!destTeam?.isActive) {
          return reply.status(404).send({
            error: { code: 'TEAM_NOT_FOUND', message: 'Target team not found or inactive' },
          });
        }
        if (!(await canManageTeamRepos(fastify.prisma, user, newTeamId))) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Requires LEAD role in the target team' },
          });
        }
      }

      const updated = await fastify.prisma.connection.update({
        data: request.body,
        include: { team: { select: { id: true, name: true, slug: true } } },
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );
};
