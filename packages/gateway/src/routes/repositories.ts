import { ConnectionTypeSchema, encryptConnectionApiToken, Prisma, Role } from '@auto-swe/shared';
import { originOf, repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendConflict } from '../lib/conflict.js';
import { redactConnection } from '../lib/connectionRedaction.js';
import { GitHubTokenMissingError, listGitHubRepos } from '../lib/github.js';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { hasRole, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * `defaultBranch` is interpolated into git commands inside the workspace
 * container. Every call site shell-quotes it, but a value that is not a valid
 * ref name should fail here, not when the first run tries to check it out.
 */
const GitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!-)[\w./-]+$/, 'must be a valid git ref name')
  .refine((v) => !v.includes('..') && !v.includes('@{') && !v.endsWith('.lock'), {
    message: 'must be a valid git ref name',
  });

const CreateRepoSchema = z.object({
  apiToken: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  defaultBranch: GitRefSchema.default('main'),
  description: z.string().optional(),
  executorImage: z.string().optional(),
  githubApiUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  /**
   * Which GitHub App installation reaches this repository. Omitted means the
   * singleton's installation, which is what every repository meant before a
   * deployment could span more than one GitHub organization.
   */
  installationId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  language: z.string().optional(),
  name: z.string().max(200).optional(),
  organizationName: z.string().min(1).optional(),
  repoName: z.string().min(1).optional(),
  teamId: z.string().uuid(),
  // MCP servers are a tool source for agents, not a workspace target, and
  // carry their own ADMIN-only, SSRF-checked routes (/admin/mcp-connections).
  // A team LEAD must not be able to create or point one at an arbitrary URL
  // through the repository onboarding path.
  type: ConnectionTypeSchema.refine((t) => t !== 'mcp', {
    message: 'MCP connections are managed at /admin/mcp-connections',
  }).default('git_repo'),
});

const ListReposQuery = paginationQuery({ defaultLimit: 200, maxLimit: 500 });

const RepoParamsSchema = z.object({ id: z.string().uuid() });

/** The full set of further teams to share a repository with; replaces the current set. */
const SharesSchema = z.object({ teamIds: z.array(z.string().uuid()).max(50) });

const UpdateRepoSchema = z.object({
  apiToken: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  consolidationEnabled: z.boolean().optional(),
  defaultBranch: GitRefSchema.optional(),
  description: z.string().nullable().optional(),
  executorImage: z.string().nullable().optional(),
  githubApiUrl: z.string().url().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  /** Null repoints the repository at the singleton's installation. */
  installationId: z.string().uuid().nullable().optional(),
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
  if (user.role === Role.ADMIN) {
    return true;
  }
  const membership = await prisma.teamMembership.findUnique({
    include: { team: { select: { isActive: true } } },
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  return !!membership && membership.team.isActive && hasRole(membership.role, Role.LEAD);
}

/**
 * Only a platform ADMIN may point a repository at a GitHub App installation.
 *
 * The installation decides which GitHub account answers permission questions
 * about the repository, so a team LEAD repointing one changes the basis of the
 * access check on their own team's repositories. It cannot grant them access
 * they do not have — a mismatched installation 404s, and the launch gate fails
 * closed on that — but it is a knob about credentials, and credentials are
 * ADMIN-scoped everywhere else in this codebase.
 */
function rejectsInstallationChange(
  user: { role: string },
  installationId: string | null | undefined
): boolean {
  return installationId !== undefined && user.role !== Role.ADMIN;
}

/**
 * Validate and normalise a repository's URL overrides for storage.
 *
 * Every GitHub credential the platform holds — and a user's own — is sent to a
 * repository's web and API bases. A team lead sets those, so an unchecked
 * override is a way to point a repository at a host the lead controls and
 * collect the platform's token on the next run. Overrides must therefore be on
 * an approved host (`repositoryHostsAllowed`), and must be BASE URLs: the
 * clone is `<web base>/<org>/<repo>.git` and the API is
 * `<api base>/repos/<org>/<repo>`, so a repository-level URL here produces a
 * path that does not exist rather than an error anyone would recognise.
 *
 * Normalised so a repository's identity is stable: the web base is stored as
 * its origin, the API base without a trailing slash, and either one equal to
 * the instance's own GitHub host is stored as null — which is what "no
 * override" already means. The unique index on (host, owner, name) keys on the
 * stored web base, so two spellings of one host must not make two
 * repositories.
 *
 * `undefined` passes through untouched (a PATCH not setting the field).
 *
 * Applies to every role, ADMIN included: an admin who wants a new host lists
 * it under `github.repositoryHosts` first, which keeps "a repository URL is on
 * an approved host" true of every row written from here on.
 */
async function normaliseRepositoryUrls(urls: {
  githubUrl?: string | null;
  githubApiUrl?: string | null;
}): Promise<
  | { ok: true; githubUrl: string | null | undefined; githubApiUrl: string | null | undefined }
  | { ok: false; message: string }
> {
  let githubUrl = urls.githubUrl;
  let githubApiUrl = urls.githubApiUrl;
  // Nothing to normalise or check: a PATCH not touching URLs reads nothing.
  if (!(githubUrl || githubApiUrl)) {
    return { githubApiUrl, githubUrl, ok: true };
  }
  const ghConfig = await resolveGitHubConfig();

  if (githubUrl) {
    const parsed = new URL(githubUrl);
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      return {
        message:
          "githubUrl must be the web base (e.g. https://ghe.example.com), not the repository's own URL",
        ok: false,
      };
    }
    githubUrl = parsed.origin === originOf(ghConfig.baseUrl) ? null : parsed.origin;
  }
  if (githubApiUrl) {
    if (new URL(githubApiUrl).pathname.includes('/repos/')) {
      return {
        message:
          "githubApiUrl must be the API base (e.g. https://ghe.example.com/api/v3), not the repository's API URL",
        ok: false,
      };
    }
    const trimmed = githubApiUrl.replace(/\/+$/, '');
    githubApiUrl =
      trimmed.toLowerCase() === ghConfig.apiUrl.replace(/\/+$/, '').toLowerCase() ? null : trimmed;
  }

  const hosts = await repositoryHostsAllowed({ githubApiUrl, githubUrl });
  if (!hosts.ok) {
    return {
      message: `${hosts.url} is not on an allowed GitHub host. A platform admin can allow it under the github.repositoryHosts setting.`,
      ok: false,
    };
  }
  return { githubApiUrl, githubUrl, ok: true };
}

/**
 * The `Connection` predicate for repositories on the same host as a (normalised)
 * web base override. Null — the instance's own host — also matches a row whose
 * override spells that host out, which rows written before overrides were
 * normalised, or on a deployment configuring its host only through the
 * environment, can carry. Both mean the same repository.
 */
async function sameHostWhere(githubUrl: string | null): Promise<Prisma.ConnectionWhereInput> {
  if (githubUrl) {
    return { githubUrl };
  }
  const instanceOrigin = originOf((await resolveGitHubConfig()).baseUrl);
  return instanceOrigin
    ? { OR: [{ githubUrl: null }, { githubUrl: instanceOrigin }] }
    : { githubUrl: null };
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
                'GitHub integration not configured. Visit /studio/integrations to add a PAT or GitHub App.',
            },
          });
        }
        throw err;
      }

      // Deliberately every team's connections. This marks which GitHub repos
      // are already imported; scoped to the caller's teams it would report a
      // repo another team already imported as available, and importing it again
      // creates a duplicate Connection for the same repository.
      // The listing comes from the instance's own host, so only repositories on
      // that host can be the same repository; `acme/api` on another host is a
      // different one.
      const onInstanceHost = await sameHostWhere(null);
      const existing = await runUnscoped(
        'import de-duplication must span every team',
        ['Connection'],
        () =>
          fastify.prisma.connection.findMany({
            select: { organizationName: true, repoName: true },
            where: { ...onInstanceHost, type: 'git_repo' },
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
      onRequest: requireAuth({ requiredRole: Role.ENGINEER }),
      schema: { querystring: ListReposQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { limit, offset } = request.query;
      const where: Prisma.ConnectionWhereInput = {
        isActive: true,
        ...(user.role !== Role.ADMIN && reachableConnections(user, request.repoAccessGate)),
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
                shares: { select: { team: { select: { id: true, name: true, slug: true } } } },
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

      return { data: repos.map(redactConnection), meta: { limit, offset, total } };
    }
  );

  // POST /api/v1/repositories — Onboard repository
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: CreateRepoSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { apiToken, organizationName, repoName, teamId, type, name, config, ...rest } =
        request.body;

      if (type === 'git_repo' && (!organizationName || !repoName)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'organizationName and repoName are required for git_repo connections',
          },
        });
      }

      if (rejectsInstallationChange(user, request.body.installationId)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only a platform admin may choose the GitHub App installation',
          },
        });
      }

      // Verify team exists
      const team = await fastify.prisma.team.findUnique({
        select: { id: true, isActive: true },
        where: { id: teamId },
      });
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

      const urls = await normaliseRepositoryUrls({
        githubApiUrl: request.body.githubApiUrl,
        githubUrl: request.body.githubUrl,
      });
      if (!urls.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'REPO_HOST_NOT_ALLOWED', message: urls.message } });
      }

      // Check for duplicate. Identity is (host, owner, name) — a partial,
      // expression-based unique index scoped to git_repo connections — so query
      // by fields rather than a compound unique. The host is the normalised web
      // base, null meaning the instance's own.
      if (type === 'git_repo' && organizationName && repoName) {
        const existing = await fastify.prisma.connection.findFirst({
          where: {
            ...(await sameHostWhere(urls.githubUrl ?? null)),
            organizationName,
            repoName,
            type: 'git_repo',
          },
        });
        if (existing) {
          return sendConflict(reply, 'REPO_EXISTS', 'Repository already onboarded');
        }
      }

      // The findFirst check above is a friendly pre-check, not a guarantee —
      // it can't stop two concurrent onboard requests from racing past it. The
      // partial unique index on (host, organizationName, repoName) for git_repo
      // connections is the real guard; catch its violation here and translate
      // it to the same 409 rather than a raw 500.
      const tokenColumns = apiToken
        ? encryptConnectionApiToken(apiToken)
        : {
            apiKeyAuthTag: null,
            apiKeyCiphertext: null,
            apiKeyNonce: null,
            apiKeyVersion: 1,
          };

      let repo: Awaited<ReturnType<typeof fastify.prisma.connection.create>>;
      try {
        repo = await fastify.prisma.connection.create({
          data: {
            ...tokenColumns,
            config: config != null ? (config as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            name: name ?? null,
            organizationName: organizationName ?? null,
            repoName: repoName ?? null,
            teamId,
            type: type ?? 'git_repo',
            ...rest,
            githubApiUrl: urls.githubApiUrl ?? null,
            githubUrl: urls.githubUrl ?? null,
          },
          include: { team: { select: { id: true, name: true, slug: true } } },
        });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return sendConflict(reply, 'REPO_EXISTS', 'Repository already onboarded');
        }
        throw err;
      }

      return reply.status(201).send({ data: redactConnection(repo) });
    }
  );

  // PATCH /api/v1/repositories/:id — Update repository config
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: UpdateRepoSchema, params: RepoParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      if (rejectsInstallationChange(user, request.body.installationId)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only a platform admin may choose the GitHub App installation',
          },
        });
      }
      const repo = await fastify.prisma.connection.findUnique({
        select: { id: true, organizationName: true, repoName: true, teamId: true, type: true },
        where: { id: request.params.id },
      });
      // MCP rows are invisible to this route (see CreateRepoSchema.type): their
      // `config.url` is only editable through the admin MCP routes.
      if (!repo || repo.type === 'mcp') {
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
        const destTeam = await fastify.prisma.team.findUnique({
          select: { isActive: true },
          where: { id: newTeamId },
        });
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

      // Only the overrides this request sets; a row already pointing somewhere
      // unapproved is refused a credential at run time instead.
      const urls = await normaliseRepositoryUrls({
        githubApiUrl: request.body.githubApiUrl,
        githubUrl: request.body.githubUrl,
      });
      if (!urls.ok) {
        return reply
          .status(400)
          .send({ error: { code: 'REPO_HOST_NOT_ALLOWED', message: urls.message } });
      }

      const {
        apiToken,
        config,
        consolidationEnabled,
        defaultBranch,
        description,
        executorImage,
        isActive,
        language,
        name,
        teamId,
      } = request.body;
      const { githubApiUrl, githubUrl } = urls;

      const tokenUpdate =
        apiToken === undefined
          ? undefined
          : apiToken
            ? encryptConnectionApiToken(apiToken)
            : {
                apiKeyAuthTag: null,
                apiKeyCiphertext: null,
                apiKeyNonce: null,
                apiKeyVersion: 1,
              };

      const moving = !!newTeamId && newTeamId !== repo.teamId;
      const updateRow = (tx: Prisma.TransactionClient) =>
        tx.connection.update({
          data: {
            ...tokenUpdate,
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

      let updated: Awaited<ReturnType<typeof updateRow>>;
      try {
        updated = moving
          ? // Moving the repository to another team: a share with its new owner
            // is now redundant, and a share with a team outside the new owner's
            // organization would carry the repository across a tenant boundary
            // that creating it never could. Dropped in the same transaction as
            // the move, so the move can never commit without the cleanup.
            await runUnscoped(
              "a repository's shares are keyed by the repository, and span the teams it names",
              ['ConnectionTeamShare'],
              () =>
                fastify.prisma.$transaction(async (tx) => {
                  const row = await updateRow(tx);
                  const owner = await tx.team.findUnique({
                    select: { orgId: true },
                    where: { id: newTeamId },
                  });
                  await tx.connectionTeamShare.deleteMany({
                    where: {
                      connectionId: repo.id,
                      // "Not in the new owner's organization" as a NOT over
                      // equality, rather than `orgId: { not: … }`, which SQL's
                      // `<>` would let a NULL slip past.
                      OR: [{ teamId: newTeamId }, { NOT: { team: { orgId: owner?.orgId } } }],
                    },
                  });
                  return row;
                })
            )
          : await updateRow(fastify.prisma);
      } catch (err) {
        // Repointing the web base onto a host where the same owner/name is
        // already onboarded collides with the (host, owner, name) identity.
        if (isUniqueConstraintError(err)) {
          return sendConflict(
            reply,
            'REPO_EXISTS',
            'That repository is already onboarded on that host'
          );
        }
        throw err;
      }

      return { data: redactConnection(updated) };
    }
  );

  // GET /api/v1/repositories/:id/share-candidates — the teams this repository
  // could be shared with: active teams in its owning team's organization, other
  // than the owner. Only for someone who may manage the repository, because a
  // team lead otherwise sees only the teams they belong to, and the share must
  // be pickable without granting a wider view of the organization.
  app.get(
    '/:id/share-candidates',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { params: RepoParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await fastify.prisma.connection.findUnique({
        select: { team: { select: { orgId: true } }, teamId: true, type: true },
        where: { id: request.params.id },
      });
      if (repo?.type !== 'git_repo') {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: "Requires LEAD role in this repository's team" },
        });
      }
      const teams = await fastify.prisma.team.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true },
        where: { id: { not: repo.teamId }, isActive: true, orgId: repo.team.orgId },
      });
      return { data: teams };
    }
  );

  // PUT /api/v1/repositories/:id/shares — replace the set of further teams the
  // repository is shared with. Members of a shared team see and launch on it;
  // the owning team keeps management, so only someone who may manage the
  // repository may change who it is shared with.
  app.put(
    '/:id/shares',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: SharesSchema, params: RepoParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await fastify.prisma.connection.findUnique({
        select: {
          id: true,
          shares: { select: { teamId: true } },
          team: { select: { orgId: true } },
          teamId: true,
          type: true,
        },
        where: { id: request.params.id },
      });
      // Repositories only: a shared MCP server or API connection would be a
      // way around the admin-only routes that manage those.
      if (repo?.type !== 'git_repo') {
        return reply.status(404).send({
          error: { code: 'REPO_NOT_FOUND', message: 'Repository not found' },
        });
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: "Requires LEAD role in this repository's team" },
        });
      }

      const teamIds = [...new Set(request.body.teamIds)].filter((id) => id !== repo.teamId);
      // Same organization only, so a share never moves a repository across a
      // tenant boundary — the organization is where budgets, members and
      // policy are drawn.
      const teams = await fastify.prisma.team.findMany({
        select: { id: true },
        where: { id: { in: teamIds }, isActive: true, orgId: repo.team.orgId },
      });
      if (teams.length !== teamIds.length) {
        const found = new Set(teams.map((t) => t.id));
        return reply.status(400).send({
          error: {
            code: 'INVALID_SHARE_TEAMS',
            message: `These teams do not exist, are inactive, or are in another organization: ${teamIds
              .filter((id) => !found.has(id))
              .join(', ')}`,
          },
        });
      }

      const before = repo.shares.map((s) => s.teamId).sort();
      await runUnscoped(
        "a repository's shares are keyed by the repository, and span the teams it names",
        ['ConnectionTeamShare'],
        () =>
          fastify.prisma.$transaction([
            fastify.prisma.connectionTeamShare.deleteMany({
              where: { connectionId: repo.id, teamId: { notIn: teamIds } },
            }),
            fastify.prisma.connectionTeamShare.createMany({
              data: teamIds.map((teamId) => ({
                connectionId: repo.id,
                createdById: user.sub,
                teamId,
              })),
              skipDuplicates: true,
            }),
          ])
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { sharedWithTeamIds: [...teamIds].sort() },
        before: { sharedWithTeamIds: before },
        entityId: repo.id,
        entityType: 'Connection',
      });

      const shares = await fastify.prisma.connection.findUnique({
        select: { shares: { select: { team: { select: { id: true, name: true, slug: true } } } } },
        where: { id: repo.id },
      });
      return { data: shares?.shares ?? [] };
    }
  );
};
