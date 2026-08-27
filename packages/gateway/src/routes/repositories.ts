import { ConnectionTypeSchema, Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GitHubTokenMissingError, listGitHubRepos } from '../lib/github.js';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { hasRole, requireAuth, requireUser } from '../plugins/auth.js';

const CreateRepoSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  defaultBranch: z.string().default('main'),
  description: z.string().optional(),
  executorImage: z.string().optional(),
  githubApiUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  isActive: z.boolean().optional(),
  language: z.string().optional(),
  name: z.string().max(200).optional(),
  organizationName: z.string().min(1).optional(),
  repoName: z.string().min(1).optional(),
  teamId: z.string().uuid(),
  type: ConnectionTypeSchema.default('git_repo'),
});

const ListReposQuery = paginationQuery({ defaultLimit: 200, maxLimit: 500 });

const RepoParamsSchema = z.object({ id: z.string().uuid() });

const UpdateRepoSchema = z.object({
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  consolidationEnabled: z.boolean().optional(),
  defaultBranch: z.string().optional(),
  description: z.string().nullable().optional(),
  executorImage: z.string().nullable().optional(),
  githubApiUrl: z.string().url().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  language: z.string().nullable().optional(),
  name: z.string().max(200).nullable().optional(),
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
export async function canManageTeamRepos(
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

  // GET /api/v1/repositories/github/available — List importable GitHub repos
  app.get(
    '/github/available',
    { onRequest: requireAuth({ requiredRole: 'LEAD' }) },
    async (_request, reply) => {
      let repos: Awaited<ReturnType<typeof listGitHubRepos>>;
      try {
        repos = await listGitHubRepos();
      } catch (err) {
        if (err instanceof GitHubTokenMissingError) {
          return reply.status(503).send({
            error: {
              code: 'GITHUB_NOT_CONFIGURED',
              message:
                'GitHub integration not configured. Visit /admin/integrations to add a PAT or GitHub App.',
            },
          });
        }
        throw err;
      }

      // Deliberately every team's connections. This marks which GitHub repos
      // are already imported; scoped to the caller's teams it would report a
      // repo another team already imported as available, and importing it again
      // creates a duplicate Connection for the same repository.
      const existing = await runUnscoped(
        'import de-duplication must span every team',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            select: { organizationName: true, repoName: true },
            where: { type: 'git_repo' },
          })
      );
      const importedSet = new Set(existing.map((c) => `${c.organizationName}/${c.repoName}`));

      return {
        data: repos.map((r) => ({
          ...r,
          alreadyImported: importedSet.has(`${r.org}/${r.name}`),
        })),
      };
    }
  );

  // GET /api/v1/repositories — List repositories
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListReposQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset } = request.query;
      const where: Prisma.ConnectionWhereInput = {
        isActive: true,
        ...(user.role !== 'ADMIN' && {
          team: { memberships: { some: { userId: user.sub } } },
        }),
      };

      const [repos, total] = await asPlatformAdmin(
        user,
        "admin lists every team's repos",
        ['Connection'],
        () =>
          Promise.all([
            fastify.prisma.connection.findMany({
              include: {
                _count: { select: { activeWorkflows: true } },
                team: { select: { id: true, name: true, slug: true } },
              },
              orderBy: { repoName: 'asc' },
              skip: offset,
              take: limit,
              where,
            }),
            fastify.prisma.connection.count({ where }),
          ])
      );

      return { data: repos, meta: { limit, offset, total } };
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
      const { organizationName, repoName, teamId, type, name, config, ...rest } = request.body;

      if (type === 'git_repo' && (!organizationName || !repoName)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'organizationName and repoName are required for git_repo connections',
          },
        });
      }

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

      // Check for duplicate (org/repo uniqueness is a partial index scoped to
      // git_repo connections, so query by fields rather than a compound unique).
      if (type === 'git_repo' && organizationName && repoName) {
        const existing = await fastify.prisma.connection.findFirst({
          where: { organizationName, repoName, type: 'git_repo' },
        });
        if (existing) {
          return reply.status(409).send({
            error: { code: 'REPO_EXISTS', message: 'Repository already onboarded' },
          });
        }
      }

      // The findFirst check above is a friendly pre-check, not a guarantee —
      // it can't stop two concurrent onboard requests from racing past it. The
      // partial unique index on (organizationName, repoName) for git_repo
      // connections is the real guard; catch its violation here and translate
      // it to the same 409 rather than a raw 500.
      let repo: Awaited<ReturnType<typeof fastify.prisma.connection.create>>;
      try {
        repo = await fastify.prisma.connection.create({
          data: {
            config: config != null ? (config as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            name: name ?? null,
            organizationName: organizationName ?? null,
            repoName: repoName ?? null,
            teamId,
            type: type ?? 'git_repo',
            ...rest,
          },
          include: { team: { select: { id: true, name: true, slug: true } } },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.status(409).send({
            error: { code: 'REPO_EXISTS', message: 'Repository already onboarded' },
          });
        }
        throw err;
      }

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

      const {
        config,
        consolidationEnabled,
        defaultBranch,
        description,
        executorImage,
        githubApiUrl,
        githubUrl,
        isActive,
        language,
        name,
        teamId,
      } = request.body;
      const updated = await fastify.prisma.connection.update({
        data: {
          config:
            config === undefined
              ? undefined
              : config != null
                ? (config as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
          consolidationEnabled,
          defaultBranch,
          description,
          executorImage,
          githubApiUrl,
          githubUrl,
          isActive,
          language,
          name,
          teamId,
        },
        include: { team: { select: { id: true, name: true, slug: true } } },
        where: { id: request.params.id },
      });

      return { data: updated };
    }
  );
};
