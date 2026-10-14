import { ConnectionTypeSchema, encryptConnectionApiToken, Prisma, Role } from '@auto-swe/shared';
import { originOf, repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { installationHostFor, sameHostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { type PermissionLookup, permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import {
  lookupRepoPermission,
  type PermissionRepo,
  verifiedGithubLoginFor,
} from '@auto-swe/shared/lib/repoPermission';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendConflict } from '../lib/conflict.js';
import { redactConnection } from '../lib/connectionRedaction.js';
import { GitHubTokenMissingError, listGitHubRepos } from '../lib/github.js';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { insensitiveName } from '../lib/repositoryHost.js';
import { ledTeams, reachableConnections } from '../lib/tenantScope.js';
import { hasRole, requireAuth, requireUser } from '../plugins/auth.js';
import { deactivateSchedulesOutsideTeams } from './scheduledWorkRequests.js';

/**
 * Deactivate the schedules that lost their claim on a repository, after the
 * change that took it away has committed. Never throws: the per-row work is
 * already tolerant, and the lookup around it must not turn a committed change
 * into a failed request.
 */
async function deactivateSchedulesOutsideTeamsQuietly(
  fastify: FastifyInstance,
  repoId: string,
  log: FastifyRequest['log'],
  actorId: string
): Promise<void> {
  try {
    await deactivateSchedulesOutsideTeams(fastify, repoId, log, actorId);
  } catch (err) {
    log.error({ err, repoId }, 'could not deactivate the schedules that lost their claim');
  }
}

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
  // Blank means inherit the deployment default, the same as omitting it.
  executorImage: z
    .string()
    .trim()
    .transform((v) => v || undefined)
    .optional(),
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
    message: 'MCP connections are managed at /studio/mcp',
  }).default('git_repo'),
});

const ListReposQuery = paginationQuery({ defaultLimit: 200, maxLimit: 500 }).extend({
  /**
   * Include deactivated connections. Only LEAD and above may reactivate one,
   * so only they are shown them; the default keeps every picker active-only.
   */
  includeInactive: booleanQueryParam(false),
  /** Case-insensitive match on a connection's repository, organization, name or description. */
  q: z.string().trim().max(100).optional(),
});

const RepoParamsSchema = z.object({ id: z.string().uuid() });

/** The full set of further teams to share a repository with; replaces the current set. */
const SharesSchema = z.object({ teamIds: z.array(z.string().uuid()).max(50) });

const UpdateRepoSchema = z.object({
  apiToken: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  consolidationEnabled: z.boolean().optional(),
  defaultBranch: GitRefSchema.optional(),
  description: z.string().nullable().optional(),
  // Blank clears the override, the same as null.
  executorImage: z
    .string()
    .trim()
    .transform((v) => v || null)
    .nullable()
    .optional(),
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
 * Why `user` may not give a repository the executor image `image`, or null
 * when they may.
 *
 * The workspace clones and pushes with the run's GitHub credential (the
 * platform's, or the launcher's own) inside this image, so whoever picks the
 * image picks code that sees that credential. Only a platform admin may name
 * one. The team shell-image allowlist is no substitute: its entries are
 * approved for sandboxed shell steps, which never hold a credential. Clearing
 * the override, and re-saving the value the row already holds, are always
 * allowed, so a lead can still edit the rest of a repository whose image an
 * admin chose.
 */
function executorImageProblem(
  user: { role: string },
  image: string | null | undefined,
  current: string | null
): { code: string; message: string; status: 400 | 403 } | null {
  if (image == null || image === current) {
    return null;
  }
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'executorImage must be a Docker image reference',
      status: 400,
    };
  }
  if (user.role === Role.ADMIN) {
    return null;
  }
  return {
    code: 'EXECUTOR_IMAGE_NOT_ALLOWED',
    message: 'Only a platform admin may set an executor image',
    status: 403,
  };
}

/**
 * Why `user` may not put the repository `repo` on the platform (or move it to
 * another host), or null when they may.
 *
 * Onboarding is what makes a repository reachable through the platform's own
 * credential: once the row exists, its team's members can launch runs that
 * clone and push with it. A team LEAD naming any `owner/name` that credential
 * can see would otherwise hand their team a repository nobody on it can open on
 * GitHub, and with `repoAccess.mode` at its default of `off` no later check
 * notices. So a non-admin must hold at least read access themselves, asked of
 * GitHub live, whatever the gate's mode.
 *
 * The caller's identity is their recorded GitHub login, verified to still be
 * theirs: the identity the launch gate asks about. A saved per-repository token
 * cannot stand in, because it belongs to a connection that does not exist yet.
 * The question is asked with the platform credential for the repository's host
 * (`lookupRepoPermission`), which applies the host allowlist and never sends a
 * credential to a host it is not valid on.
 *
 * Fails closed: a question GitHub did not answer is not a yes.
 */
async function onboardingAccessProblem(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string },
  repo: PermissionRepo & { organizationName: string; repoName: string }
): Promise<{ code: string; message: string; status: 403 | 503 } | null> {
  if (user.role === Role.ADMIN) {
    return null;
  }
  const slug = `${repo.organizationName}/${repo.repoName}`;
  const unavailable = {
    code: 'GITHUB_UNAVAILABLE',
    message: `Your GitHub access to ${slug} could not be confirmed right now. Try again shortly.`,
    status: 503 as const,
  };
  let login: string | null;
  let lookup: PermissionLookup;
  try {
    login = await verifiedGithubLoginFor(prisma, user.sub);
    if (!login) {
      return {
        code: 'GITHUB_ACCESS_UNVERIFIED',
        message:
          'No GitHub account is linked to you, so your access to this repository cannot be checked. Sign in with GitHub once to link your account, or ask a platform admin to onboard it.',
        status: 403,
      };
    }
    lookup = await lookupRepoPermission(repo, login);
  } catch {
    return unavailable;
  }
  // No access and no such repository give the same answer, so a lead cannot
  // probe which private repositories the platform credential can see.
  const unconfirmed = {
    code: 'GITHUB_ACCESS_UNVERIFIED',
    message: `GitHub did not confirm that you can read ${slug}: you have no access, it does not exist, or the platform's GitHub credential cannot see it. Ask a platform admin to onboard it.`,
    status: 403 as const,
  };
  if (lookup.ok) {
    return permissionMeets(lookup.permission, 'read') ? null : unconfirmed;
  }
  if (lookup.failure === 'rate-limited' || lookup.failure === 'unavailable') {
    return unavailable;
  }
  if (lookup.failure === 'host-mismatch') {
    return {
      code: 'GITHUB_ACCESS_UNVERIFIED',
      message: `No platform GitHub credential applies to the host of ${slug}, so your access to it cannot be checked. Ask a platform admin to onboard it.`,
      status: 403,
    };
  }
  return unconfirmed;
}

/**
 * Why the installation `installationId` cannot serve a repository with these
 * (normalised) URL overrides, or null when it can.
 *
 * An installation lives on one GitHub host, and its token is minted at that
 * host's API with that host's App. A repository on another host would be sent
 * that host's installation id — a different installation, or none — so the pair
 * must agree: the instance's own host takes installations with an empty host,
 * any other host takes the ones recorded for it.
 */
async function installationHostProblem(
  fastify: FastifyInstance,
  installationId: string | null | undefined,
  urls: { githubUrl: string | null; githubApiUrl: string | null }
): Promise<string | null> {
  if (!installationId) {
    return null;
  }
  const installation = await fastify.prisma.gitHubInstallation.findUnique({
    select: { host: true, installationId: true },
    where: { id: installationId },
  });
  if (!installation) {
    // The foreign key reports an unknown installation.
    return null;
  }
  const expected = installationHostFor(
    { apiUrl: urls.githubApiUrl, baseUrl: urls.githubUrl },
    await resolveGitHubConfig()
  );
  if (installation.host === expected) {
    return null;
  }
  const where = (h: string) => (h ? h : "the instance's own host");
  return `Installation ${installation.installationId} is on ${where(installation.host)}, but this repository is on ${where(expected)}. Choose an installation recorded for that host.`;
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
 * The two bases must be on the same host (treating null as the instance's own),
 * so overrides come in matching pairs; github.com with api.github.com, and
 * `<tenant>.ghe.com` with `api.<tenant>.ghe.com`, are each one host. A web base
 * of one host with an API base of another would have a token minted for one
 * sent to the other — embedded in a clone URL, or sent as a bearer. A PATCH is
 * judged against `existing`, the row's stored overrides, for the field it does
 * not set.
 *
 * Applies to every role, ADMIN included: an admin who wants a new host lists
 * it under `github.repositoryHosts` first, which keeps "a repository URL is on
 * an approved host" true of every row written from here on.
 */
async function normaliseRepositoryUrls(
  urls: {
    githubUrl?: string | null;
    githubApiUrl?: string | null;
  },
  existing: { githubUrl: string | null; githubApiUrl: string | null } = {
    githubApiUrl: null,
    githubUrl: null,
  }
): Promise<
  | { ok: true; githubUrl: string | null | undefined; githubApiUrl: string | null | undefined }
  | { ok: false; message: string; code?: string }
> {
  let githubUrl = urls.githubUrl;
  let githubApiUrl = urls.githubApiUrl;
  // Nothing to normalise or check: a PATCH not touching URLs reads nothing, and
  // clearing both overrides leaves a repository on the instance's own host.
  if (githubUrl === undefined && githubApiUrl === undefined) {
    return { githubApiUrl, githubUrl, ok: true };
  }
  if (!(githubUrl || githubApiUrl || existing.githubUrl || existing.githubApiUrl)) {
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

  // Overrides come in matching pairs. What the row will hold: this request's
  // value where it set one, the stored one otherwise.
  const effectiveUrl = githubUrl === undefined ? existing.githubUrl : githubUrl;
  const effectiveApi = githubApiUrl === undefined ? existing.githubApiUrl : githubApiUrl;
  if (
    (effectiveUrl || effectiveApi) &&
    !sameHostFamily(effectiveUrl ?? ghConfig.baseUrl, effectiveApi ?? ghConfig.apiUrl)
  ) {
    return {
      code: 'REPO_HOST_MISMATCH',
      message: `The web URL (${effectiveUrl ?? `the instance's ${ghConfig.baseUrl}`}) and API URL (${effectiveApi ?? `the instance's ${ghConfig.apiUrl}`}) are on different hosts. Set both overrides to the same host (or neither); a credential minted for one host would be sent to the other.`,
      ok: false,
    };
  }
  return { githubApiUrl, githubUrl, ok: true };
}

/**
 * The `Connection` predicate for repositories on the same host as a (normalised)
 * web base override. Null — the instance's own host — also matches a row whose
 * override spells that host out, which rows written before overrides were
 * normalised, or before the instance's host changed, can carry. Both mean the
 * same repository.
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
          return sendError(
            reply,
            503,
            'GITHUB_NOT_CONFIGURED',
            'GitHub integration not configured. Visit /studio/integrations to add a PAT or GitHub App.'
          );
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
      const importedSet = new Set(
        existing.map((c) => `${c.organizationName}/${c.repoName}`.toLowerCase())
      );

      return {
        data: repos.map((r) => ({
          ...r,
          alreadyImported: importedSet.has(`${r.org}/${r.name}`.toLowerCase()),
        })),
      };
    }
  );

  // GET /api/v1/repositories — List repositories
  app.get(
    '/',
    {
      config: { mcpScope: 'read' },
      onRequest: requireAuth({ requiredRole: Role.ENGINEER }),
      schema: { querystring: ListReposQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const { includeInactive, limit, offset, q } = request.query;
      const showInactive = includeInactive && hasRole(user.role, Role.LEAD);
      // A deactivated connection is listed only to someone who could reactivate
      // it: a platform ADMIN, or a LEAD/ADMIN of the owning team (the bar
      // `canManageTeamRepos` sets for the write). The platform LEAD role alone
      // is not that — on a team where they are a plain ENGINEER they would be
      // shown rows they can do nothing with.
      const reach =
        user.role === Role.ADMIN ? null : reachableConnections(user, request.repoAccessGate);
      // Combined, never blindly spread: the reachability predicate is itself an
      // `AND` of `OR`s, and spreading two objects that set the same key keeps
      // only whichever came last — silently dropping either the reachability
      // check or the active filter. `isActive` has its own key, so it spreads;
      // the LEAD view needs an `OR` of its own beside the reachability `AND`, so
      // the two are joined explicitly.
      let where: Prisma.ConnectionWhereInput;
      if (!showInactive) {
        where = { ...reach, isActive: true };
      } else if (reach === null) {
        where = {};
      } else {
        where = { AND: [reach, { OR: [{ isActive: true }, { team: ledTeams(user) }] }] };
      }
      if (q) {
        const contains = { contains: q, mode: 'insensitive' as const };
        where = {
          AND: [
            where,
            {
              OR: [
                { repoName: contains },
                { organizationName: contains },
                { name: contains },
                { description: contains },
              ],
            },
          ],
        };
      }

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
        return sendError(
          reply,
          400,
          'VALIDATION_ERROR',
          'organizationName and repoName are required for git_repo connections'
        );
      }

      if (rejectsInstallationChange(user, request.body.installationId)) {
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only a platform admin may choose the GitHub App installation'
        );
      }

      // Verify team exists
      const team = await fastify.prisma.team.findUnique({
        select: { id: true, isActive: true },
        where: { id: teamId },
      });
      if (!team?.isActive) {
        return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Team not found or inactive');
      }

      // Non-admins may only onboard repos into teams they lead.
      if (!(await canManageTeamRepos(fastify.prisma, user, teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', 'Requires LEAD role in the target team');
      }

      const imageProblem = executorImageProblem(user, request.body.executorImage, null);
      if (imageProblem) {
        return sendError(reply, imageProblem.status, imageProblem.code, imageProblem.message);
      }

      const urls = await normaliseRepositoryUrls({
        githubApiUrl: request.body.githubApiUrl,
        githubUrl: request.body.githubUrl,
      });
      if (!urls.ok) {
        return sendError(reply, 400, urls.code ?? 'REPO_HOST_NOT_ALLOWED', urls.message);
      }

      const installationProblem = await installationHostProblem(
        fastify,
        request.body.installationId,
        { githubApiUrl: urls.githubApiUrl ?? null, githubUrl: urls.githubUrl ?? null }
      );
      if (installationProblem) {
        return sendError(reply, 400, 'INSTALLATION_HOST_MISMATCH', installationProblem);
      }

      // Before the duplicate check, so someone without access to a repository
      // does not learn whether it is already onboarded.
      if (type === 'git_repo' && organizationName && repoName) {
        const accessProblem = await onboardingAccessProblem(fastify.prisma, user, {
          githubApiUrl: urls.githubApiUrl ?? null,
          githubUrl: urls.githubUrl ?? null,
          // Only a platform admin may choose one, and an admin is not asked.
          installation: null,
          organizationName,
          repoName,
        });
        if (accessProblem) {
          return sendError(reply, accessProblem.status, accessProblem.code, accessProblem.message);
        }
      }

      // Check for duplicate. Identity is (host, owner, name) — a partial,
      // expression-based unique index scoped to git_repo connections — so query
      // by fields rather than a compound unique. The host is the normalised web
      // base, null meaning the instance's own.
      if (type === 'git_repo' && organizationName && repoName) {
        const existing = await fastify.prisma.connection.findFirst({
          where: {
            ...(await sameHostWhere(urls.githubUrl ?? null)),
            // GitHub treats owner and name case-insensitively.
            organizationName: insensitiveName(organizationName),
            repoName: insensitiveName(repoName),
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
        return sendError(
          reply,
          403,
          'FORBIDDEN',
          'Only a platform admin may choose the GitHub App installation'
        );
      }
      const repo = await fastify.prisma.connection.findUnique({
        select: {
          executorImage: true,
          githubApiUrl: true,
          githubUrl: true,
          id: true,
          installation: { select: { host: true, installationId: true } },
          installationId: true,
          organizationName: true,
          repoName: true,
          teamId: true,
          type: true,
        },
        where: { id: request.params.id },
      });
      // MCP rows are invisible to this route (see CreateRepoSchema.type): their
      // `config.url` is only editable through the admin MCP routes.
      if (!repo || repo.type === 'mcp') {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }

      // Non-admins must lead the repo's current team to edit it...
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
      }
      // ...and, when reassigning to a different team, also lead the destination.
      const newTeamId = request.body.teamId;
      if (newTeamId && newTeamId !== repo.teamId) {
        const destTeam = await fastify.prisma.team.findUnique({
          select: { isActive: true },
          where: { id: newTeamId },
        });
        if (!destTeam?.isActive) {
          return sendError(reply, 404, 'TEAM_NOT_FOUND', 'Target team not found or inactive');
        }
        if (!(await canManageTeamRepos(fastify.prisma, user, newTeamId))) {
          return sendError(reply, 403, 'FORBIDDEN', 'Requires LEAD role in the target team');
        }
      }

      const imageProblem = executorImageProblem(
        user,
        request.body.executorImage,
        repo.executorImage
      );
      if (imageProblem) {
        return sendError(reply, imageProblem.status, imageProblem.code, imageProblem.message);
      }

      // Only the overrides this request sets; a row already pointing somewhere
      // unapproved is refused a credential at run time instead.
      const urls = await normaliseRepositoryUrls(
        { githubApiUrl: request.body.githubApiUrl, githubUrl: request.body.githubUrl },
        { githubApiUrl: repo.githubApiUrl, githubUrl: repo.githubUrl }
      );
      if (!urls.ok) {
        return sendError(reply, 400, urls.code ?? 'REPO_HOST_NOT_ALLOWED', urls.message);
      }

      const {
        apiToken,
        config,
        consolidationEnabled,
        defaultBranch,
        description,
        executorImage,
        installationId,
        isActive,
        language,
        name,
        teamId,
      } = request.body;
      const { githubApiUrl, githubUrl } = urls;

      // The installation the row will hold must live on the host the row will
      // be on. Judged when either side changes, so repointing a repository to
      // another host cannot leave it minting tokens through the old host's
      // installation.
      if (installationId !== undefined || githubUrl !== undefined || githubApiUrl !== undefined) {
        const installationProblem = await installationHostProblem(
          fastify,
          installationId === undefined ? repo.installationId : installationId,
          {
            githubApiUrl: githubApiUrl === undefined ? repo.githubApiUrl : githubApiUrl,
            githubUrl: githubUrl === undefined ? repo.githubUrl : githubUrl,
          }
        );
        if (installationProblem) {
          return sendError(reply, 400, 'INSTALLATION_HOST_MISMATCH', installationProblem);
        }
      }

      // The same owner/name on another host is another repository, so moving a
      // repository there is onboarding that one: the caller must be able to
      // read it. A non-admin cannot change the installation, so the row's own
      // is the one that will answer.
      const movesHost =
        (githubUrl !== undefined && githubUrl !== repo.githubUrl) ||
        (githubApiUrl !== undefined && githubApiUrl !== repo.githubApiUrl);
      if (movesHost && repo.type === 'git_repo' && repo.organizationName && repo.repoName) {
        const accessProblem = await onboardingAccessProblem(fastify.prisma, user, {
          githubApiUrl: githubApiUrl === undefined ? repo.githubApiUrl : githubApiUrl,
          githubUrl: githubUrl === undefined ? repo.githubUrl : githubUrl,
          installation: repo.installation ?? null,
          organizationName: repo.organizationName,
          repoName: repo.repoName,
        });
        if (accessProblem) {
          return sendError(reply, accessProblem.status, accessProblem.code, accessProblem.message);
        }
      }

      // Repointing the web base moves the repository onto another host, where
      // the same owner/name (compared case-insensitively) may already be
      // onboarded. The database index may still be the case-sensitive one, so
      // this is the guard for a case-only collision, as it is when onboarding.
      if (
        githubUrl !== undefined &&
        repo.type === 'git_repo' &&
        repo.organizationName &&
        repo.repoName
      ) {
        const existing = await fastify.prisma.connection.findFirst({
          select: { id: true },
          where: {
            ...(await sameHostWhere(githubUrl)),
            id: { not: repo.id },
            organizationName: insensitiveName(repo.organizationName),
            repoName: insensitiveName(repo.repoName),
            type: 'git_repo',
          },
        });
        if (existing) {
          return sendConflict(
            reply,
            'REPO_EXISTS',
            'That repository is already onboarded on that host'
          );
        }
      }

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
            installationId,
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
              ['ConnectionTeamShare', 'KnowledgeItem'],
              () =>
                fastify.prisma.$transaction(async (tx) => {
                  // CLAUDE.md §7 exception: serialize moves with repo-origin KnowledgeItem inserts.
                  await tx.$queryRaw(
                    Prisma.sql`SELECT id FROM connections WHERE id = ${repo.id}::uuid FOR UPDATE`
                  );
                  const existingKnowledge = await tx.knowledgeItem.count({
                    where: { repoId: repo.id },
                  });
                  if (existingKnowledge > 0) {
                    throw new Error('KNOWLEDGE_REASSIGNMENT_CONFLICT');
                  }
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
        if (err instanceof Error && err.message === 'KNOWLEDGE_REASSIGNMENT_CONFLICT') {
          return sendConflict(
            reply,
            'KNOWLEDGE_SOURCE_IN_USE',
            'Repository with governed knowledge cannot be reassigned'
          );
        }
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

      // A move drops the shares that no longer apply and changes who owns the
      // repository, so schedules owned by a team with no remaining claim stop.
      if (moving) {
        await deactivateSchedulesOutsideTeamsQuietly(fastify, repo.id, request.log, user.sub);
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
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
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
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
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
        return sendError(
          reply,
          400,
          'INVALID_SHARE_TEAMS',
          `These teams do not exist, are inactive, or are in another organization: ${teamIds
            .filter((id) => !found.has(id))
            .join(', ')}`
        );
      }

      const before = repo.shares.map((s) => s.teamId).sort();
      await runUnscoped(
        "a repository's shares are keyed by the repository, and span the teams it names",
        ['ConnectionTeamShare'],
        () =>
          fastify.prisma.$transaction(async (tx) => {
            // CLAUDE.md §7 exception: serialize share replacement with source checks.
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM connections WHERE id = ${repo.id}::uuid FOR UPDATE`
            );
            await tx.connectionTeamShare.deleteMany({
              where: { connectionId: repo.id, teamId: { notIn: teamIds } },
            });
            return tx.connectionTeamShare.createMany({
              data: teamIds.map((teamId) => ({
                connectionId: repo.id,
                createdById: user.sub,
                teamId,
              })),
              skipDuplicates: true,
            });
          })
      );
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: user,
        after: { sharedWithTeamIds: [...teamIds].sort() },
        before: { sharedWithTeamIds: before },
        entityId: repo.id,
        entityType: 'Connection',
      });
      // A team that lost its share keeps no schedule on the repository. After the
      // audit, because the change is committed: a failure here must not leave it
      // unrecorded, nor turn it into a 500.
      await deactivateSchedulesOutsideTeamsQuietly(fastify, repo.id, request.log, user.sub);

      const shares = await fastify.prisma.connection.findUnique({
        select: { shares: { select: { team: { select: { id: true, name: true, slug: true } } } } },
        where: { id: repo.id },
      });
      return { data: shares?.shares ?? [] };
    }
  );
};
