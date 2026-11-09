import crypto from 'node:crypto';
import {
  ConnectionTypeSchema,
  encryptConnectionApiToken,
  encryptSecret,
  Prisma,
  Role,
} from '@auto-swe/shared';
import { originOf, repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
// From the subpath, not the barrel: this module is pure (zod only), so a test that
// mocks the barrel to avoid instantiating the Prisma client still gets the real one.
import { isConnectionType } from '@auto-swe/shared/lib/connectionTypes';
import { credentialDestinationChanged } from '@auto-swe/shared/lib/credentialDestination';
import { installationHostFor, sameHostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { type PermissionLookup, permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import {
  PREVIEW_ENV_LOOKS_SECRET,
  type PreviewConfig,
  PreviewConfigInputSchema,
  PreviewConfigSchema,
  secretLookingEnvKeys,
} from '@auto-swe/shared/lib/previewConfig';
import { PR_TITLE_FORMATS } from '@auto-swe/shared/lib/prTitle';
import {
  lookupRepoPermission,
  PERMISSION_REPO_SELECT,
  type PermissionRepo,
  verifiedGithubLoginFor,
} from '@auto-swe/shared/lib/repoPermission';
import {
  MAX_REPO_SETUP_SECRETS,
  MIN_REPO_SETUP_SECRET_CHARS,
  type RepoSetup,
  RepoSetupSchema,
  RepoSetupSecretNameSchema,
} from '@auto-swe/shared/lib/repoSetup';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { ToolKeySchema } from '@auto-swe/shared/lib/toolCatalog';
import { MAX_TOOLS_IN_FILE, ToolRequestSchema } from '@auto-swe/shared/lib/toolsFile';
import { REPO_GATE_COMMAND_KEYS, type RepoGateCommands } from '@auto-swe/shared/types/api';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendConflict } from '../lib/conflict.js';
import { probeRepositoryAccess } from '../lib/connectionProbes.js';
import { redactConnection } from '../lib/connectionRedaction.js';
import { GitHubTokenMissingError, listGitHubRepos } from '../lib/github.js';
import { sendError } from '../lib/httpErrors.js';
import { paginationQuery } from '../lib/pagination.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { REPOSITORY_SWEEP_CAP, sweepArmedPullRequests } from '../lib/prEvaluationSweep.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import { insensitiveName } from '../lib/repositoryHost.js';
import { isShellAuthor } from '../lib/specCheck.js';
import { ledTeams, reachableConnections } from '../lib/tenantScope.js';
import { hasRole, type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
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

/** A repository's gate commands in a request body; see `normaliseGateCommands`. */
const GateCommandsSchema = z
  .partialRecord(z.enum(REPO_GATE_COMMAND_KEYS), z.string().max(4000).nullable())
  .nullable()
  .optional();

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
  /** Gate commands to onboard with; setting any takes the shell authoring role on `teamId`. */
  gateCommands: GateCommandsSchema,
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
  previewConfig: PreviewConfigSchema.nullable().optional(),
  repoName: z.string().min(1).optional(),
  setup: RepoSetupSchema.nullable().optional(),
  teamId: z.string().uuid(),
  // MCP servers are a tool source for agents, not a workspace target, and
  // carry their own ADMIN-only, SSRF-checked routes (/admin/mcp-connections).
  // A team LEAD must not be able to create or point one at an arbitrary URL
  // through the repository onboarding path.
  type: ConnectionTypeSchema.refine((t) => t !== 'mcp', {
    message: 'MCP connections are managed at /mcp',
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

const setupFileRequestPrefix = (repoId: string) => `repo-setup-file-${repoId}-`;

/** The full set of further teams to share a repository with; replaces the current set. */
const SharesSchema = z.object({ teamIds: z.array(z.string().uuid()).max(50) });

/** Tool keys the repository may never install; at most this many, repeats collapsed. */
const MAX_TOOLS_DENY = 64;

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
  /** How the executor image was built; only platform admins may set it, anyone may clear. */
  executorImageBuild: z
    .object({
      stack: z.enum(['node', 'node-browser', 'python', 'jvm', 'go']),
      useRepoDockerfile: z.boolean(),
    })
    .nullable()
    .optional(),
  /**
   * The repository's gate commands, replacing the stored set: a gate left out, null or blank
   * falls back to the built-in default, and null clears them all. Commands an author writes, so
   * changing them takes the shell authoring role (see `gateCommandsProblem`).
   */
  gateCommands: GateCommandsSchema,
  githubApiUrl: z.string().url().nullable().optional(),
  githubUrl: z.string().url().nullable().optional(),
  /** Null repoints the repository at the singleton's installation. */
  installationId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  language: z.string().nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  previewConfig: PreviewConfigSchema.nullable().optional(),
  /** The repository's own PR title format; null inherits `workflow.prTitleFormat`. */
  prTitleFormat: z.enum(PR_TITLE_FORMATS).nullable().optional(),
  /** The repository's own PR title template; blank or null inherits. */
  prTitleTemplate: z
    .string()
    .trim()
    .max(300)
    .transform((v) => v || null)
    .nullable()
    .optional(),
  setup: RepoSetupSchema.nullable().optional(),
  teamId: z.string().uuid().optional(),
  /** Tools an admin installs into every run's workspace; null clears. Platform admins only. */
  tools: z
    .array(ToolRequestSchema)
    .max(MAX_TOOLS_IN_FILE)
    .refine((list) => new Set(list.map((t) => t.key)).size === list.length, {
      message: 'tools must not repeat a key',
    })
    .nullable()
    .optional(),
  /** Catalog keys the repository may never install; wins over `tools` and the file. */
  toolsDeny: z
    .array(ToolKeySchema)
    .max(MAX_TOOLS_DENY)
    .transform((keys) => [...new Set(keys)])
    .optional(),
  /** Whether `.auto-swe/tools.yml` on the base ref is honoured. Platform admins only. */
  toolsFileEnabled: z.boolean().optional(),
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

/** The overrides that run something: blank and null entries dropped; none at all is null. */
function normaliseGateCommands(value: unknown): RepoGateCommands | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const out: RepoGateCommands = {};
  for (const key of REPO_GATE_COMMAND_KEYS) {
    const command = (value as Record<string, unknown>)[key];
    if (typeof command === 'string' && command.trim() !== '') {
      out[key] = command;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sameGateCommands(a: RepoGateCommands | null, b: RepoGateCommands | null): boolean {
  return REPO_GATE_COMMAND_KEYS.every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));
}

/**
 * Why `user` may not give a repository the gate commands `next`, or null when they may.
 *
 * A gate command runs in the agent workspace of every run on the repository that does not set its
 * own — the same reach as a `command` an author writes into a template, so it takes the same
 * `workflow:write:shell` role: a platform admin, or an admin of the team that will own the
 * repository. Re-saving the stored set is always allowed, so a lead can still edit the rest of a
 * repository whose commands an admin chose; clearing them is a change like any other, because a
 * cleared command makes every run fall back to the built-in default.
 */
async function gateCommandsProblem(
  fastify: FastifyInstance,
  user: JwtPayload,
  repo: { gateCommands: unknown; teamId: string; type: string },
  next: RepoGateCommands | null,
  ownerTeamId: string
): Promise<{ code: string; message: string; status: 400 | 403 } | null> {
  if (sameGateCommands(next, normaliseGateCommands(repo.gateCommands))) {
    return null;
  }
  if (repo.type !== 'git_repo') {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Only a git repository has gate commands',
      status: 400,
    };
  }
  if (await isShellAuthor(fastify, user, ownerTeamId)) {
    return null;
  }
  return {
    code: 'GATE_COMMANDS_FORBIDDEN',
    message: "Changing a repository's gate commands requires team-admin role",
    status: 403,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalJson(child)])
    );
  }
  return value;
}

function samePreviewConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a ?? null)) === JSON.stringify(canonicalJson(b ?? null));
}

async function setupProblem(
  fastify: FastifyInstance,
  user: JwtPayload,
  repo: { setup: unknown; teamId: string; type: string },
  next: RepoSetup | null,
  ownerTeamId: string
): Promise<{ code: string; message: string; status: 400 | 403 } | null> {
  if (samePreviewConfig(next, repo.setup)) {
    return null;
  }
  if (repo.type !== 'git_repo') {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Only a git repository can have a workspace setup',
      status: 400,
    };
  }
  if (await isShellAuthor(fastify, user, ownerTeamId)) {
    return null;
  }
  return {
    code: 'REPO_SETUP_FORBIDDEN',
    message: "Changing a repository's workspace setup requires team-admin role",
    status: 403,
  };
}

async function previewConfigProblem(
  fastify: FastifyInstance,
  user: JwtPayload,
  repo: { previewConfig: unknown; teamId: string; type: string },
  next: PreviewConfig | null,
  ownerTeamId: string
): Promise<{ code: string; message: string; status: 400 | 403 } | null> {
  if (samePreviewConfig(next, repo.previewConfig)) {
    return null;
  }
  if (repo.type !== 'git_repo') {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Only a git repository can have an app preview recipe',
      status: 400,
    };
  }
  if (!(await isShellAuthor(fastify, user, ownerTeamId))) {
    return {
      code: 'PREVIEW_CONFIG_FORBIDDEN',
      message: "Changing a repository's app preview requires team-admin role",
      status: 403,
    };
  }
  const secretLooking = secretLookingEnvKeys(next?.env, next?.publicEnv);
  if (secretLooking.length) {
    return {
      code: PREVIEW_ENV_LOOKS_SECRET,
      message: `The app preview env holds secret-looking values (${secretLooking.join(', ')}). Save them as setup secrets and name them under secrets instead, or list a key whose value only looks random (a commit SHA, a UUID) under publicEnv.`,
      status: 400,
    };
  }
  return null;
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

/** A stored or submitted tool list as comparable text; null and empty are the same list. */
function toolListKey(value: unknown): string {
  if (!Array.isArray(value)) {
    return '[]';
  }
  return JSON.stringify(
    value.map((t) => {
      const { key, version } = t as { key: string; version?: string };
      return version === undefined ? { key } : { key, version };
    })
  );
}

/** A deny list as comparable text; order does not matter. */
function toolDenyKey(value: readonly string[] | null | undefined): string {
  return JSON.stringify([...new Set(value ?? [])].sort());
}

/**
 * What the PATCH changes among the tool settings, judged against the row. A value equal to the
 * stored one is no change, so a lead can still save the rest of a repository an admin configured.
 */
function toolSettingChanges(
  body: { tools?: unknown[] | null; toolsDeny?: string[]; toolsFileEnabled?: boolean },
  current: { tools: unknown; toolsDeny: string[]; toolsFileEnabled: boolean }
): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  tools: boolean;
  toolsDeny: boolean;
  toolsFileEnabled: boolean;
} {
  const tools = body.tools !== undefined && toolListKey(body.tools) !== toolListKey(current.tools);
  const toolsDeny =
    body.toolsDeny !== undefined && toolDenyKey(body.toolsDeny) !== toolDenyKey(current.toolsDeny);
  const toolsFileEnabled =
    body.toolsFileEnabled !== undefined && body.toolsFileEnabled !== current.toolsFileEnabled;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (tools) {
    before.tools = current.tools ?? null;
    after.tools = body.tools ?? null;
  }
  if (toolsDeny) {
    before.toolsDeny = current.toolsDeny;
    after.toolsDeny = body.toolsDeny;
  }
  if (toolsFileEnabled) {
    before.toolsFileEnabled = current.toolsFileEnabled;
    after.toolsFileEnabled = body.toolsFileEnabled;
  }
  return { after, before, tools, toolsDeny, toolsFileEnabled };
}

/**
 * What the PATCH writes for `executorImageBuild`, or {} for no change. The
 * record says how `build-executor.yml` built the current image, so it goes
 * with that image: an explicit null clears it, and so does any change to the
 * image the body did not pair with a new record (a cleared or hand-set image
 * was not built by the workflow). Re-sending the image the row already holds
 * — which the settings form does on every save — keeps it.
 */
function executorImageBuildUpdate(
  body: {
    executorImage?: string | null;
    executorImageBuild?: { stack: string; useRepoDockerfile: boolean } | null;
  },
  currentImage: string | null
): { executorImageBuild?: Prisma.InputJsonValue | typeof Prisma.DbNull } {
  if (body.executorImageBuild != null) {
    return { executorImageBuild: body.executorImageBuild as Prisma.InputJsonValue };
  }
  const imageChanged = body.executorImage !== undefined && body.executorImage !== currentImage;
  if (body.executorImageBuild === null || imageChanged) {
    return { executorImageBuild: Prisma.DbNull };
  }
  return {};
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
            'GitHub integration not configured. Visit /admin/integrations to add a PAT or GitHub App.'
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
      const {
        apiToken,
        organizationName,
        repoName,
        teamId,
        type,
        name,
        config,
        gateCommands: rawGateCommands,
        previewConfig,
        setup,
        ...rest
      } = request.body;

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

      // Judged as a change from none, the same rule an edit applies.
      const gateCommands = normaliseGateCommands(rawGateCommands);
      const gateProblem = await gateCommandsProblem(
        fastify,
        user,
        { gateCommands: null, teamId, type: type ?? 'git_repo' },
        gateCommands,
        teamId
      );
      if (gateProblem) {
        return sendError(reply, gateProblem.status, gateProblem.code, gateProblem.message);
      }
      const previewProblem = await previewConfigProblem(
        fastify,
        user,
        { previewConfig: null, teamId, type: type ?? 'git_repo' },
        previewConfig ?? null,
        teamId
      );
      if (previewProblem) {
        return sendError(reply, previewProblem.status, previewProblem.code, previewProblem.message);
      }
      const setupCreateProblem = await setupProblem(
        fastify,
        user,
        { setup: null, teamId, type: type ?? 'git_repo' },
        setup ?? null,
        teamId
      );
      if (setupCreateProblem) {
        return sendError(
          reply,
          setupCreateProblem.status,
          setupCreateProblem.code,
          setupCreateProblem.message
        );
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
            previewConfig:
              previewConfig != null ? (previewConfig as Prisma.InputJsonValue) : Prisma.DbNull,
            repoName: repoName ?? null,
            setup: setup != null ? (setup as Prisma.InputJsonValue) : Prisma.DbNull,
            teamId,
            type: type ?? 'git_repo',
            ...rest,
            ...(gateCommands ? { gateCommands: gateCommands as Prisma.InputJsonValue } : {}),
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
      if (gateCommands) {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: { gateCommands },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }
      if (previewConfig != null) {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: { previewConfig },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }
      if (setup != null) {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: { setup },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }

      // Scan it now rather than at the next weekly sweep: the detected stack picks the gate
      // commands, the test command and the executor image, so until a scan has run the repository
      // gets the Node defaults whatever it is. Best-effort — the sweep scans it regardless, and a
      // Temporal hiccup must not fail an onboarding that has already happened.
      if ((type ?? 'git_repo') === 'git_repo') {
        try {
          await fastify.temporal.startRepoDependencyScan(repo.id);
        } catch (err) {
          request.log.warn(
            { err, repoId: repo.id },
            'onboarding scan not started; the weekly sweep will scan this repository'
          );
        }
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
          apiKeyCiphertext: true,
          config: true,
          defaultBranch: true,
          executorImage: true,
          executorImageBuild: true,
          gateCommands: true,
          githubApiUrl: true,
          githubUrl: true,
          id: true,
          installation: { select: { host: true, installationId: true } },
          installationId: true,
          organizationName: true,
          previewConfig: true,
          repoName: true,
          setup: true,
          teamId: true,
          tools: true,
          toolsDeny: true,
          toolsFileEnabled: true,
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
      // executorImageBuild records how an image was built; the same authority
      // applies (admins set, anyone may clear), and clearing the image clears it.
      if (request.body.executorImageBuild != null && user.role !== Role.ADMIN) {
        return sendError(
          reply,
          403,
          'EXECUTOR_IMAGE_NOT_ALLOWED',
          'Only a platform admin may set executorImageBuild'
        );
      }

      // What gets installed into a workspace holding the repository's credential is chosen from
      // the catalog by a platform admin: the same authority as the executor image. Re-saving a
      // value the row already holds is allowed.
      const toolChanges = toolSettingChanges(request.body, repo);
      if (
        (toolChanges.tools || toolChanges.toolsDeny || toolChanges.toolsFileEnabled) &&
        user.role !== Role.ADMIN
      ) {
        return sendError(
          reply,
          403,
          'TOOLS_CONFIG_NOT_ALLOWED',
          "Only a platform admin may change a repository's tool settings"
        );
      }

      const nextGateCommands =
        request.body.gateCommands === undefined
          ? undefined
          : normaliseGateCommands(request.body.gateCommands);
      const gateCommandsChange =
        nextGateCommands !== undefined &&
        !sameGateCommands(nextGateCommands, normaliseGateCommands(repo.gateCommands));
      if (nextGateCommands !== undefined) {
        // Judged against the team that will own the repository, so a move and a change in one
        // request need the role on the destination.
        const gateProblem = await gateCommandsProblem(
          fastify,
          user,
          repo,
          nextGateCommands,
          request.body.teamId ?? repo.teamId
        );
        if (gateProblem) {
          return sendError(reply, gateProblem.status, gateProblem.code, gateProblem.message);
        }
      }
      const nextPreviewConfig = request.body.previewConfig;
      const previewConfigChange =
        nextPreviewConfig !== undefined &&
        !samePreviewConfig(nextPreviewConfig, repo.previewConfig);
      if (nextPreviewConfig !== undefined) {
        const previewProblem = await previewConfigProblem(
          fastify,
          user,
          repo,
          nextPreviewConfig,
          request.body.teamId ?? repo.teamId
        );
        if (previewProblem) {
          return sendError(
            reply,
            previewProblem.status,
            previewProblem.code,
            previewProblem.message
          );
        }
      }
      const nextSetup = request.body.setup;
      const setupChange = nextSetup !== undefined && !samePreviewConfig(nextSetup, repo.setup);
      if (nextSetup !== undefined) {
        const problem = await setupProblem(
          fastify,
          user,
          repo,
          nextSetup,
          request.body.teamId ?? repo.teamId
        );
        if (problem) {
          return sendError(reply, problem.status, problem.code, problem.message);
        }
      }
      // Moving a repository hands its gate commands to the destination team: they run in every
      // run the new owners launch. Unchanged commands were not vouched for by anyone there, so
      // the move takes the role on the destination, as a change would.
      const keptGateCommands =
        nextGateCommands === undefined
          ? normaliseGateCommands(repo.gateCommands)
          : nextGateCommands;
      if (
        newTeamId &&
        newTeamId !== repo.teamId &&
        keptGateCommands !== null &&
        !gateCommandsChange &&
        !(await isShellAuthor(fastify, user, newTeamId))
      ) {
        return sendError(
          reply,
          403,
          'GATE_COMMANDS_FORBIDDEN',
          'Moving a repository with gate commands requires team-admin role in the target team'
        );
      }
      const keptPreviewConfig =
        nextPreviewConfig === undefined ? repo.previewConfig : nextPreviewConfig;
      if (
        newTeamId &&
        newTeamId !== repo.teamId &&
        keptPreviewConfig != null &&
        !previewConfigChange &&
        !(await isShellAuthor(fastify, user, newTeamId))
      ) {
        return sendError(
          reply,
          403,
          'PREVIEW_CONFIG_FORBIDDEN',
          'Moving a repository with an app preview requires team-admin role in the target team'
        );
      }
      const keptSetup = nextSetup === undefined ? repo.setup : nextSetup;
      if (
        newTeamId &&
        newTeamId !== repo.teamId &&
        keptSetup != null &&
        !setupChange &&
        !(await isShellAuthor(fastify, user, newTeamId))
      ) {
        return sendError(
          reply,
          403,
          'REPO_SETUP_FORBIDDEN',
          'Moving a repository with a workspace setup requires team-admin role in the target team'
        );
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
        previewConfig: bodyPreviewConfig,
        prTitleFormat,
        prTitleTemplate,
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

      // A stored credential belongs to the destination it was entered for. Pointing
      // the connection somewhere else while keeping it would send that team's secret
      // to a host its owner never approved — and `config` is editable by a LEAD, who
      // cannot read the secret they would be redirecting. `apiToken === undefined`
      // means "keep the stored one"; supplying or clearing it is the explicit consent,
      // exactly as the `mcp` route requires.
      if (
        repo.apiKeyCiphertext != null &&
        apiToken === undefined &&
        config !== undefined &&
        isConnectionType(repo.type) &&
        credentialDestinationChanged(
          { config: repo.config, type: repo.type },
          { config: config ?? null, type: repo.type }
        )
      ) {
        return sendError(
          reply,
          409,
          'TOKEN_ORIGIN_CHANGE',
          'This connection has a stored API token. Changing where it would be sent — the base URL, ' +
            'the tracker provider, or the Zendesk subdomain — would send it somewhere its owner never ' +
            'approved. Enter a new token, or clear the stored one first.'
        );
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
      // An admin enabled `.auto-swe/tools.yml` for THIS repository. A lead who repoints the
      // row at another repository (its URLs) or another team would carry that trust decision
      // along, so the flag is cleared in the same write and an admin has to enable it again.
      // `defaultBranch` counts too: it is the ref the file is read from, so moving it points the
      // admin's decision at a branch nobody vetted.
      const identityChanged =
        moving ||
        (githubUrl !== undefined && githubUrl !== repo.githubUrl) ||
        (githubApiUrl !== undefined && githubApiUrl !== repo.githubApiUrl) ||
        (defaultBranch !== undefined && defaultBranch !== repo.defaultBranch);
      const clearToolsFile = user.role !== Role.ADMIN && repo.toolsFileEnabled && identityChanged;
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
            ...executorImageBuildUpdate(request.body, repo.executorImage),
            ...(toolChanges.tools
              ? {
                  tools:
                    request.body.tools == null
                      ? Prisma.DbNull
                      : (request.body.tools as Prisma.InputJsonValue),
                }
              : {}),
            ...(toolChanges.toolsDeny ? { toolsDeny: request.body.toolsDeny } : {}),
            ...(toolChanges.toolsFileEnabled
              ? { toolsFileEnabled: request.body.toolsFileEnabled }
              : {}),
            ...(clearToolsFile ? { toolsFileEnabled: false } : {}),
            ...(gateCommandsChange
              ? {
                  gateCommands:
                    nextGateCommands != null
                      ? (nextGateCommands as Prisma.InputJsonValue)
                      : Prisma.DbNull,
                }
              : {}),
            githubApiUrl,
            githubUrl,
            installationId,
            isActive,
            language,
            name,
            ...(previewConfigChange
              ? {
                  previewConfig:
                    bodyPreviewConfig === null
                      ? Prisma.DbNull
                      : (bodyPreviewConfig as Prisma.InputJsonValue),
                }
              : {}),
            prTitleFormat,
            prTitleTemplate,
            ...(setupChange
              ? {
                  setup: nextSetup === null ? Prisma.DbNull : (nextSetup as Prisma.InputJsonValue),
                }
              : {}),
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
      // A deactivated repository is evaluated no more, so an auto-merge the platform armed on one
      // of its pull requests would otherwise stay armed. Best effort: the update has happened.
      if (isActive === false) {
        try {
          await sweepArmedPullRequests(fastify, request.log, {
            cap: REPOSITORY_SWEEP_CAP,
            connectionId: repo.id,
          });
        } catch (err) {
          request.log.error(
            { connectionId: repo.id, err },
            'pull request disarm sweep after a deactivation failed (non-fatal)'
          );
        }
      }
      // A gate command runs in every run's workspace, so who set which is kept, like a
      // template's `WorkflowShellAudit` row.
      if (gateCommandsChange) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { gateCommands: nextGateCommands },
          before: { gateCommands: normaliseGateCommands(repo.gateCommands) },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }
      if (previewConfigChange) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { previewConfig: nextPreviewConfig },
          before: { previewConfig: repo.previewConfig },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }
      if (setupChange) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: { setup: nextSetup },
          before: { setup: repo.setup },
          entityId: repo.id,
          entityType: 'Connection',
        });
      }

      // What a workspace installs is a security decision, so who changed it is kept.
      if (toolChanges.tools || toolChanges.toolsDeny || toolChanges.toolsFileEnabled) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: toolChanges.after,
          before: toolChanges.before,
          entityId: repo.id,
          entityType: 'Connection',
        });
      }

      if (clearToolsFile) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: user,
          after: {
            toolsFileEnabled: false,
            toolsFileEnabledClearedBy: 'repository identity change',
          },
          before: { toolsFileEnabled: true },
          entityId: repo.id,
          entityType: 'Connection',
        });
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

  // POST /api/v1/repositories/:id/test-access — what a run on this repository could do: the
  // platform credential for its host mints a token, sees the repository, may push, and the
  // default branch exists; and the same for the caller's own saved token, when they have one.
  // Only someone who may manage the repository: it is an existing connection, so this answers
  // "does it work", never "which private repositories can the platform credential see". Always 200
  // with `ok` so the page can show the reason.
  app.post(
    '/:id/test-access',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { params: RepoParamsSchema },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const repo = await fastify.prisma.connection.findUnique({
        select: {
          ...PERMISSION_REPO_SELECT,
          defaultBranch: true,
          id: true,
          teamId: true,
          type: true,
        },
        where: { id: request.params.id },
      });
      if (repo?.type !== 'git_repo') {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!(await canManageTeamRepos(fastify.prisma, user, repo.teamId))) {
        return sendError(reply, 403, 'FORBIDDEN', "Requires LEAD role in this repository's team");
      }
      return { data: await probeRepositoryAccess(fastify.prisma, repo, user.sub) };
    }
  );

  // POST /api/v1/repositories/:id/setup/pull-request — open a pull request that adds
  // `.auto-swe/setup.yml`, written from the given definition, to the repository's default branch.
  // The same role as changing the setup field: the file is code every workspace runs. A worker
  // opens the pull request; this answers 202 with a request id at once, and the status route
  // below reports it opened, or failed (`exists` when the default branch already has the file;
  // this never edits one).
  const setupFileRepo = async (request: FastifyRequest, id: string) => {
    const user = requireUser(request);
    const repo = await fastify.prisma.connection.findUnique({
      select: { id: true, teamId: true, type: true },
      where: { id },
    });
    if (repo?.type !== 'git_repo') {
      return { error: 404 as const, ok: false as const };
    }
    if (!(await isShellAuthor(fastify, user, repo.teamId))) {
      return { error: 403 as const, ok: false as const };
    }
    return { ok: true as const, repo, user };
  };
  const sendSetupFileRepoError = (reply: FastifyReply, error: 403 | 404) =>
    error === 404
      ? sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found')
      : sendError(
          reply,
          403,
          'REPO_SETUP_FORBIDDEN',
          "Changing a repository's workspace setup requires team-admin role"
        );

  app.post(
    '/:id/setup/pull-request',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { body: z.object({ setup: RepoSetupSchema }), params: RepoParamsSchema },
    },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      const requestId = `${setupFileRequestPrefix(found.repo.id)}${crypto.randomBytes(8).toString('hex')}`;
      await fastify.temporal.startRepoSetupFileProposal(requestId, {
        connectionId: found.repo.id,
        setup: request.body.setup,
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor: found.user,
        after: { setupFilePullRequestRequested: requestId },
        entityId: found.repo.id,
        entityType: 'Connection',
      });
      return reply.status(202).send({ data: { requestId } });
    }
  );

  app.get(
    '/:id/setup/pull-request/:requestId',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: {
        params: RepoParamsSchema.extend({ requestId: z.string().max(100) }),
      },
    },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      // The id names its repository, so one repository's admin cannot read another's request.
      const prefix = setupFileRequestPrefix(found.repo.id);
      const { requestId } = request.params;
      if (!requestId.startsWith(prefix) || !/^[0-9a-f]{16}$/.test(requestId.slice(prefix.length))) {
        return sendError(reply, 404, 'NOT_FOUND', 'Setup file request not found');
      }
      return { data: await fastify.temporal.getRepoSetupFileProposalStatus(requestId) };
    }
  );

  // Setup secrets: values a repository's workspace setup names under `secrets:`, stored
  // encrypted and write-only. The same team-admin role as the setup itself; reads return the
  // name and last four characters, never a value, and audit entries carry only the name.
  const secretSummary = (row: { name: string; valueLastFour: string; updatedAt: Date }) => ({
    lastFour: row.valueLastFour,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
  });
  const SetupSecretParamsSchema = RepoParamsSchema.extend({ name: RepoSetupSecretNameSchema });

  // GET /api/v1/repositories/:id/setup/secrets — the repository's setup secrets, without values.
  app.get(
    '/:id/setup/secrets',
    { onRequest: requireAuth({ requiredRole: Role.LEAD }), schema: { params: RepoParamsSchema } },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      const rows = await fastify.prisma.repoSetupSecret.findMany({
        orderBy: { name: 'asc' },
        select: { name: true, updatedAt: true, valueLastFour: true },
        where: { connectionId: found.repo.id },
      });
      return { data: rows.map(secretSummary) };
    }
  );

  // PUT /api/v1/repositories/:id/setup/secrets/:name — set (or replace) one setup secret.
  app.put(
    '/:id/setup/secrets/:name',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: {
        body: z.object({
          value: z
            .string()
            .min(
              MIN_REPO_SETUP_SECRET_CHARS,
              `must be at least ${MIN_REPO_SETUP_SECRET_CHARS} characters`
            )
            .max(16_384),
        }),
        params: SetupSecretParamsSchema,
      },
    },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      const { name } = request.params;
      const existing = await fastify.prisma.repoSetupSecret.count({
        where: { connectionId: found.repo.id },
      });
      const sealed = encryptSecret(request.body.value);
      const value = {
        valueAuthTag: sealed.authTag,
        valueCiphertext: sealed.ciphertext,
        valueKeyVersion: sealed.keyVersion,
        valueLastFour: sealed.lastFour,
        valueNonce: sealed.nonce,
      };
      const prior = await fastify.prisma.repoSetupSecret.findUnique({
        select: { id: true },
        where: { connectionId_name: { connectionId: found.repo.id, name } },
      });
      if (!prior && existing >= MAX_REPO_SETUP_SECRETS) {
        return sendError(
          reply,
          409,
          'SETUP_SECRET_LIMIT',
          `A repository holds at most ${MAX_REPO_SETUP_SECRETS} setup secrets`
        );
      }
      const row = await fastify.prisma.repoSetupSecret.upsert({
        create: { connectionId: found.repo.id, name, ...value },
        select: { name: true, updatedAt: true, valueLastFour: true },
        update: value,
        where: { connectionId_name: { connectionId: found.repo.id, name } },
      });
      await writeAuditLog(fastify, {
        action: prior ? 'UPDATE' : 'CREATE',
        actor: found.user,
        after: { setupSecret: name },
        entityId: found.repo.id,
        entityType: 'Connection',
      });
      return { data: secretSummary(row) };
    }
  );

  // POST /api/v1/repositories/:id/preview/env-to-secrets — move app preview `env` values into
  // setup secrets of the same names, so they are stored encrypted, and name them under the
  // recipe's `secrets`. `names` picks the values; by default, the secret-looking ones. Refused
  // whole when a name is already a setup secret or a value is too short to be one.
  app.post(
    '/:id/preview/env-to-secrets',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: {
        body: z
          .object({
            names: z.array(RepoSetupSecretNameSchema).min(1).max(MAX_REPO_SETUP_SECRETS).optional(),
          })
          .nullish(),
        params: RepoParamsSchema,
      },
    },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      const row = await fastify.prisma.connection.findUniqueOrThrow({
        select: { previewConfig: true },
        where: { id: found.repo.id },
      });
      const parsed = PreviewConfigInputSchema.safeParse(row.previewConfig);
      const env = parsed.success ? (parsed.data.env ?? {}) : {};
      const names = [
        ...new Set(request.body?.names ?? secretLookingEnvKeys(env, parsed.data?.publicEnv)),
      ];
      if (!parsed.success || names.length === 0) {
        return sendError(
          reply,
          400,
          'NO_PREVIEW_ENV',
          'The app preview recipe has no secret-looking env values to move'
        );
      }
      const absent = names.filter((n) => !(n in env));
      if (absent.length) {
        return sendError(
          reply,
          400,
          'NOT_IN_PREVIEW_ENV',
          `Not in the app preview env: ${absent.join(', ')}`
        );
      }
      const short = names.filter((n) => (env[n] ?? '').length < MIN_REPO_SETUP_SECRET_CHARS);
      if (short.length) {
        return sendError(
          reply,
          400,
          'SETUP_SECRET_TOO_SHORT',
          `A setup secret must be at least ${MIN_REPO_SETUP_SECRET_CHARS} characters: ${short.join(', ')}. Leave ${short.length > 1 ? 'them' : 'it'} in env, or replace the value.`
        );
      }
      const held = await fastify.prisma.repoSetupSecret.findMany({
        select: { name: true },
        where: { connectionId: found.repo.id },
      });
      const clash = names.filter((n) => held.some((h) => h.name === n));
      if (clash.length) {
        return sendError(
          reply,
          409,
          'SETUP_SECRET_EXISTS',
          `Already setup secrets: ${clash.join(', ')}. Rename or remove them first.`
        );
      }
      if (held.length + names.length > MAX_REPO_SETUP_SECRETS) {
        return sendError(
          reply,
          409,
          'SETUP_SECRET_LIMIT',
          `A repository holds at most ${MAX_REPO_SETUP_SECRETS} setup secrets`
        );
      }
      const { env: _env, ...rest } = parsed.data;
      const kept = Object.fromEntries(Object.entries(env).filter(([n]) => !names.includes(n)));
      const next = {
        ...rest,
        ...(Object.keys(kept).length ? { env: kept } : {}),
        secrets: [...(rest.secrets ?? []), ...names],
      };
      const checked = PreviewConfigInputSchema.safeParse(next);
      if (!checked.success) {
        return sendError(
          reply,
          400,
          'INVALID_PREVIEW_CONFIG',
          checked.error.issues[0]?.message ?? 'invalid'
        );
      }
      await fastify.prisma.$transaction([
        ...names.map((name) => {
          const sealed = encryptSecret(env[name] as string);
          return fastify.prisma.repoSetupSecret.create({
            data: {
              connectionId: found.repo.id,
              name,
              valueAuthTag: sealed.authTag,
              valueCiphertext: sealed.ciphertext,
              valueKeyVersion: sealed.keyVersion,
              valueLastFour: sealed.lastFour,
              valueNonce: sealed.nonce,
            },
          });
        }),
        fastify.prisma.connection.update({
          data: { previewConfig: checked.data as Prisma.InputJsonValue },
          where: { id: found.repo.id },
        }),
      ]);
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor: found.user,
        after: { previewEnvMovedToSetupSecrets: names },
        entityId: found.repo.id,
        entityType: 'Connection',
      });
      return { data: { moved: names, previewConfig: checked.data } };
    }
  );

  // Which eval datasets the caller may link to a repository's setup secrets: its team's TEAM
  // datasets as a team admin, and its organization's ORG datasets as an ORG_ADMIN of that
  // organization. A platform ADMIN may link both.
  const evalLinkAccess = async (request: FastifyRequest, id: string) => {
    const user = requireUser(request);
    const repo = await fastify.prisma.connection.findUnique({
      select: { id: true, team: { select: { orgId: true } }, teamId: true, type: true },
      where: { id },
    });
    if (repo?.type !== 'git_repo') {
      return null;
    }
    const orgId = repo.team?.orgId ?? null;
    const teamAdmin = repo.teamId !== null && (await isShellAuthor(fastify, user, repo.teamId));
    const orgAdmin =
      orgId !== null &&
      (user.role === 'ADMIN' ||
        (
          await fastify.prisma.organizationMembership.findUnique({
            select: { role: true },
            where: { userId_orgId: { orgId, userId: user.sub } },
          })
        )?.role === 'ORG_ADMIN');
    return {
      orgId: orgAdmin ? orgId : null,
      repo,
      teamId: teamAdmin ? repo.teamId : null,
      user,
    };
  };

  // GET /api/v1/repositories/:id/setup/eval-datasets — the eval datasets the caller may link to
  // this repository's setup secrets (see evalLinkAccess), and which of them read them. Empty for
  // a caller who may link none. GLOBAL datasets are linked from the platform eval admin page.
  app.get(
    '/:id/setup/eval-datasets',
    { onRequest: requireAuth(), schema: { params: RepoParamsSchema } },
    async (request, reply) => {
      const access = await evalLinkAccess(request, request.params.id);
      if (!access) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const select = {
        id: true,
        name: true,
        scope: true,
        setupSecretsConnection: {
          select: { id: true, name: true, organizationName: true, repoName: true },
        },
        slug: true,
      } as const;
      const [teamRows, orgRows] = await Promise.all([
        access.teamId
          ? fastify.prisma.evalDataset.findMany({
              orderBy: { name: 'asc' },
              select,
              where: { scope: 'TEAM', teamId: access.teamId },
            })
          : [],
        access.orgId
          ? fastify.prisma.evalDataset.findMany({
              orderBy: { name: 'asc' },
              select,
              where: { orgId: access.orgId, scope: 'ORGANIZATION' },
            })
          : [],
      ]);
      const rows = [...teamRows, ...orgRows];
      return {
        data: rows.map((r) => ({
          id: r.id,
          linked: r.setupSecretsConnection?.id === access.repo.id,
          name: r.name,
          scope: r.scope,
          slug: r.slug,
          // Set when the dataset reads another repository's setup secrets.
          usesRepository:
            r.setupSecretsConnection && r.setupSecretsConnection.id !== access.repo.id
              ? {
                  id: r.setupSecretsConnection.id,
                  name:
                    r.setupSecretsConnection.name ??
                    `${r.setupSecretsConnection.organizationName}/${r.setupSecretsConnection.repoName}`,
                }
              : null,
        })),
      };
    }
  );

  // PUT /api/v1/repositories/:id/setup/eval-datasets/:datasetId — link (or unlink) a dataset the
  // caller may link (see evalLinkAccess) to this repository's setup secrets. Linking replaces any
  // other repository; unlinking only clears a link to this one.
  app.put(
    '/:id/setup/eval-datasets/:datasetId',
    {
      onRequest: requireAuth(),
      schema: {
        body: z.object({ linked: z.boolean() }),
        params: z.object({ datasetId: z.string().uuid(), id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const access = await evalLinkAccess(request, request.params.id);
      if (!access) {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      if (!access.teamId && !access.orgId) {
        return sendError(
          reply,
          403,
          'EVAL_DATASET_LINK_FORBIDDEN',
          "Linking eval datasets to a repository's setup secrets requires team-admin role, or organization-admin role for organization datasets"
        );
      }
      const { linked } = request.body;
      const repoId = access.repo.id;
      const result = await fastify.prisma.$transaction(async (tx) => {
        const ds = await tx.evalDataset.findUnique({
          select: {
            id: true,
            orgId: true,
            scope: true,
            setupSecretsConnectionId: true,
            teamId: true,
          },
          where: { id: request.params.datasetId },
        });
        const allowed =
          ds &&
          ((ds.scope === 'TEAM' && access.teamId !== null && ds.teamId === access.teamId) ||
            (ds.scope === 'ORGANIZATION' && access.orgId !== null && ds.orgId === access.orgId));
        if (!allowed) {
          return null;
        }
        const before = ds.setupSecretsConnectionId;
        const after = linked ? repoId : before === repoId ? null : before;
        if (after !== before) {
          await tx.evalDataset.update({
            data: { setupSecretsConnectionId: after },
            where: { id: ds.id },
          });
        }
        return { after, before, id: ds.id };
      });
      if (!result) {
        return sendError(
          reply,
          404,
          'DATASET_NOT_FOUND',
          'Eval dataset not found among those you may link to this repository'
        );
      }
      if (result.after !== result.before) {
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: access.user,
          after: { setupSecretsConnectionId: result.after },
          before: { setupSecretsConnectionId: result.before },
          entityId: result.id,
          entityType: 'EvalDataset',
        });
      }
      return { data: { linked: result.after === repoId } };
    }
  );

  // DELETE /api/v1/repositories/:id/setup/secrets/:name — remove one setup secret.
  app.delete(
    '/:id/setup/secrets/:name',
    {
      onRequest: requireAuth({ requiredRole: Role.LEAD }),
      schema: { params: SetupSecretParamsSchema },
    },
    async (request, reply) => {
      const found = await setupFileRepo(request, request.params.id);
      if (!found.ok) {
        return sendSetupFileRepoError(reply, found.error);
      }
      const { name } = request.params;
      const { count } = await fastify.prisma.repoSetupSecret.deleteMany({
        where: { connectionId: found.repo.id, name },
      });
      if (count === 0) {
        return sendError(reply, 404, 'NOT_FOUND', 'Setup secret not found');
      }
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: found.user,
        before: { setupSecret: name },
        entityId: found.repo.id,
        entityType: 'Connection',
      });
      return reply.status(204).send();
    }
  );

  // POST /api/v1/repositories/:id/executor-image/probe — check an executor
  // image against the workspace contract by starting it as a hardened
  // workspace container and running the contract probe inside it. Platform
  // ADMIN only: the image is code that runs next to the platform's git
  // credential, the same authority `executorImageProblem` applies to setting
  // one. The image defaults to the repository's override. With none, the worker
  // resolves the one its runs would use — the deployer's image for the detected
  // stack (sent along), else the workspace default.
  app.post(
    '/:id/executor-image/probe',
    {
      onRequest: requireAuth({ requiredRole: Role.ADMIN }),
      schema: {
        body: z.object({ image: z.string().max(500).optional() }),
        params: RepoParamsSchema,
      },
    },
    async (request, reply) => {
      const repo = await fastify.prisma.connection.findUnique({
        select: { detectedStack: true, executorImage: true, type: true },
        where: { id: request.params.id },
      });
      if (repo?.type !== 'git_repo') {
        return sendError(reply, 404, 'REPO_NOT_FOUND', 'Repository not found');
      }
      const image = request.body.image ?? repo.executorImage ?? undefined;
      if (image !== undefined && !DOCKER_IMAGE_REF_RE.test(image)) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'image must be a Docker image reference');
      }
      const result = await fastify.temporal.probeExecutorImage(
        `executor-image-probe-${request.params.id}-${crypto.randomBytes(8).toString('hex')}`,
        // With no image named, the worker resolves the one this repository's runs would use: the
        // deployer's image for its detected stack (an environment variable only the worker is
        // sure to have), else the default. A named image is probed as given.
        {
          detectedStack: image === undefined ? (repo.detectedStack ?? undefined) : undefined,
          image,
        }
      );
      return { data: result };
    }
  );
};
