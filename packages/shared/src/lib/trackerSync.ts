import {
  resolveEffectiveSettings,
  resolveSetting,
  type SettingResolveCtx,
} from '../config/index.js';
import { SETTING_DEFINITIONS } from '../config/registry.js';
import { hostFamily } from './githubHostScope.js';
import {
  GITHUB_ISSUES_DEFAULT_BASE_URL,
  parseGitHubTicketId,
} from './integrations/providers/githubIssues.js';
import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import { createIssueTrackerProvider } from './integrations/registry.js';
import type { TicketFailureClass } from './integrations/ticketFailure.js';
import type { TrackerSyncEvent, TrackerSyncOutcome } from './integrations/types.js';
import { resolveGitHubBaseUrl } from './systemConfig.js';
import { runUnscoped } from './tenantGuard.js';

export type { TrackerSyncEvent, TrackerSyncOutcome };

// Lazy DB access, as in systemConfig.ts: importing this module must not load the client.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/** The repository columns a GitHub-tracker write is checked against. */
export interface TrackerScopeRepo {
  organizationName: string | null;
  repoName: string | null;
  /** The repository's web base override; null/empty → the instance's. */
  githubUrl?: string | null;
  /** The repository's API base override; null/empty → the instance's. */
  githubApiUrl?: string | null;
  /** The owning team, so the operator's allowlist resolves at the run's own scope. */
  teamId?: string | null;
  /** The owning team's organization, for the same reason. */
  team?: { orgId?: string | null } | null;
}

/**
 * The repositories a run targets, where a repository with no URL override lives, and the
 * repositories an operator authorised beyond them.
 */
export interface TrackerRepoScope {
  /**
   * `owner/repo` entries of `github.trackerIssueRepositories`, which are on the tracker's host by
   * definition. Absent or empty: only `repos` count. Only a ticket id that names its repository
   * can match one; a bare number never does.
   */
  extraRepos?: ReadonlyArray<string>;
  /** The instance's GitHub web URL (`resolveGitHubBaseUrl`). */
  instanceBaseUrl: string;
  repos: ReadonlyArray<TrackerScopeRepo>;
  /**
   * Jira project keys / Linear team keys of `github.trackerAllowedProjectKeys`, the union of the
   * non-empty lists across the targeted repositories' contexts. Empty: unrestricted.
   */
  allowedProjectKeys: string[];
  /** True when a project-key list could not be read: a Jira/Linear read is then refused. */
  projectKeysUnreadable?: boolean;
}

/**
 * The team (and its organization) a launch is attributed to when it names no git repository: the
 * launching template's own. Project-key allowlists resolve here for a connection-less launch, so
 * a team-restricted user cannot read any ticket by picking a template with no repository. A global
 * template has no team, so such a launch resolves at GLOBAL only.
 */
export interface TrackerLaunchTeam {
  teamId?: string | null;
  orgId?: string | null;
}

/**
 * The team contexts a launch with no git repository resolves the project-key allowlist at: one
 * team (the launching template's), or a list (the launcher's own teams, when the template has
 * none). A list is read like several repositories: every context is read and the non-empty lists
 * are unioned; each context's own list overrides GLOBAL (GLOBAL is not unioned in). An empty list
 * is GLOBAL only.
 */
export type TrackerLaunchScope = TrackerLaunchTeam | ReadonlyArray<TrackerLaunchTeam> | null;

/**
 * A {@link TrackerLaunchScope}, or a function that loads one. The function is called only when a
 * targeted repository supplies no team context of its own, so a run that targets a repository
 * with a team never pays for (or fails on) the launch lookup.
 */
export type TrackerLaunchSource = TrackerLaunchScope | (() => Promise<TrackerLaunchScope>);

function launchTeamCtxs(scope: TrackerLaunchScope | undefined): SettingResolveCtx[] {
  const teams: ReadonlyArray<TrackerLaunchTeam | null> = !scope
    ? []
    : Array.isArray(scope)
      ? scope
      : [scope as TrackerLaunchTeam];
  const ctxs: SettingResolveCtx[] = [];
  for (const team of teams) {
    if (team?.teamId) {
      const ctx: SettingResolveCtx = { teamId: team.teamId };
      if (team.orgId) {
        ctx.orgId = team.orgId;
      }
      ctxs.push(ctx);
    }
  }
  return ctxs;
}

/**
 * The setting scope a repository's issue-repository allowlist resolves at. Null when there is no
 * repository, or it names no owning team: an empty context would resolve at GLOBAL and skip every
 * team and organization override, so the caller treats null as "no extra repositories".
 */
function repoSettingCtx(repo: TrackerScopeRepo | undefined): SettingResolveCtx | null {
  if (!repo?.teamId) {
    return null;
  }
  const ctx: SettingResolveCtx = { teamId: repo.teamId };
  if (repo.team?.orgId) {
    ctx.orgId = repo.team.orgId;
  }
  return ctx;
}

/** {@link resolveTrackerIssueRepos} at a repository's scope; empty when it has no team context. */
async function resolveRepoIssueRepos(repo: TrackerScopeRepo | undefined): Promise<string[]> {
  const ctx = repoSettingCtx(repo);
  return ctx ? resolveTrackerIssueRepos(ctx) : [];
}

/**
 * The operator's extra tracker repositories (`github.trackerIssueRepositories`) at `ctx`. Fails
 * closed: a read that throws, or a value that is not a list of strings, is an empty list, never a
 * wider one.
 */
export async function resolveTrackerIssueRepos(ctx: SettingResolveCtx): Promise<string[]> {
  try {
    const value: unknown = await resolveSetting('github.trackerIssueRepositories', ctx);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The Jira/Linear project-key allowlist across the contexts a request targets (each repository's
 * team and organization; with no repository or a repository naming no team, the launch's own
 * team contexts: the launching template's team and organization when it has one, else the
 * launcher's own teams, else GLOBAL, so a global list still applies to a connection-less launch;
 * a context's own list overrides GLOBAL, which is not unioned in). Rule: every context is read;
 * the result is the union of the NON-EMPTY lists, so a key is allowed iff some non-empty list names it, and the
 * request is unrestricted (empty result) only when ALL lists are empty. An unreadable list is
 * reported, never treated as empty: the caller refuses. That includes a stored row that fails the
 * setting's schema, which the generic resolver would silently degrade to the next (wider) tier.
 */
async function resolveProjectKeyScope(
  repos: ReadonlyArray<TrackerScopeRepo | undefined>,
  launchTeam?: TrackerLaunchSource
): Promise<{ allowedProjectKeys: string[]; projectKeysUnreadable?: true }> {
  const definition = SETTING_DEFINITIONS['github.trackerAllowedProjectKeys'];
  try {
    const ctxs = new Map<string, SettingResolveCtx>();
    // The launch's own contexts are loaded lazily, and only when some targeted repository names
    // no team: a lookup that would not be used neither costs a query nor refuses the read. One
    // that is needed and fails lands in the catch below, so the list is unreadable (fail closed).
    let fallback: SettingResolveCtx[] | null = null;
    for (const repo of repos.length > 0 ? repos : [undefined]) {
      const repoCtx = repoSettingCtx(repo);
      if (!repoCtx && fallback === null) {
        const loaded = typeof launchTeam === 'function' ? await launchTeam() : launchTeam;
        const launchCtxs = launchTeamCtxs(loaded);
        fallback = launchCtxs.length > 0 ? launchCtxs : [{}];
      }
      for (const ctx of repoCtx ? [repoCtx] : (fallback ?? [])) {
        ctxs.set(`${ctx.teamId ?? ''}|${ctx.orgId ?? ''}`, ctx);
      }
    }
    const lists = await Promise.all(
      [...ctxs.values()].map(async (ctx) => {
        // The resolver degrades a stored value that fails its schema to the next tier, which here
        // is a wider (or unrestricted) list. A restriction must not loosen that way: read the
        // stored rows too, and treat one that does not parse as unreadable.
        const { overrideAt } = await resolveEffectiveSettings(ctx);
        const scopes = [
          'GLOBAL' as const,
          ...(ctx.orgId && definition.overridableAt.includes('ORGANIZATION')
            ? ['ORGANIZATION' as const]
            : []),
          ...(ctx.teamId && definition.overridableAt.includes('TEAM') ? ['TEAM' as const] : []),
        ];
        for (const scope of scopes) {
          const stored = overrideAt('github.trackerAllowedProjectKeys', scope);
          if (stored !== undefined && !definition.schema.safeParse(stored).success) {
            throw new Error('unreadable');
          }
        }
        const value: unknown = await resolveSetting('github.trackerAllowedProjectKeys', ctx);
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new Error('unreadable');
        }
        return value as string[];
      })
    );
    const byLower = new Map<string, string>();
    for (const key of lists.flat()) {
      byLower.set(key.toLowerCase(), key);
    }
    return { allowedProjectKeys: [...byLower.values()] };
  } catch {
    return { allowedProjectKeys: [], projectKeysUnreadable: true };
  }
}

/**
 * The project/team key of a Jira or Linear ticket id: the segment before the final `-<number>`
 * (`PAY-12` → `PAY`). Null for anything else.
 */
export function parseTrackerProjectKey(ticketId: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(ticketId.trim());
  return match?.[1] ?? null;
}

/**
 * The host family (`githubHostScope.hostFamily`) of an http(s) URL: lowercased, default port
 * dropped, the scheme and path ignored, and a hosted GitHub's API host folded into its web host.
 * Null for anything that does not parse as http(s), so every caller fails closed on it.
 */
function httpHostFamily(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    return null;
  }
  return hostFamily(url);
}

/** Whether every host the repository states (the instance's, when it states none) is `host`. */
function repoOnHost(repo: TrackerScopeRepo, host: string, instanceBaseUrl: string): boolean {
  const stated = [repo.githubApiUrl, repo.githubUrl].filter((url): url is string => !!url);
  const urls = stated.length > 0 ? stated : [instanceBaseUrl];
  return urls.every((url) => httpHostFamily(url) === host);
}

/**
 * Does `ticketId` name an issue in one of the run's repositories, on the host the GitHub tracker
 * writes to? The id is user-supplied and names its own `owner/repo`, so without this the tracker's
 * token would write to any repository a launch cared to name, on its own host. Owner and repo
 * compare case-insensitively, as GitHub resolves them; the host is the tracker's `baseUrl`, or
 * the provider's default when it has none. A bare `#123` names no repository and is refused, as
 * is anything whose host does not parse — unless the caller passes the `defaultRepo` the provider
 * resolves a bare number against (a read does, a write does not), which is then checked like any
 * other repository.
 *
 * A ticket that names its own repository is also in scope when the operator listed that
 * repository in `scope.extraRepos`. Those are on the tracker's host by definition (the provider
 * only calls its own base URL), so the host comparison is not applied to them. A bare number
 * never matches the list: it resolves only against `defaultRepo`.
 */
export function isGitHubTicketInScope(
  ticketId: string,
  trackerBaseUrl: string | null | undefined,
  scope: TrackerRepoScope,
  defaultRepo?: { owner: string; repo: string }
): boolean {
  const parsed = parseGitHubTicketId(ticketId, defaultRepo);
  const trackerHost = httpHostFamily(trackerBaseUrl ?? GITHUB_ISSUES_DEFAULT_BASE_URL);
  if (!parsed || !trackerHost) {
    return false;
  }
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();
  if (
    scope.extraRepos?.length &&
    parseGitHubTicketId(ticketId) &&
    scope.extraRepos.some((entry) => entry.toLowerCase() === `${owner}/${repo}`)
  ) {
    return true;
  }
  return scope.repos.some(
    (r) =>
      r.organizationName?.toLowerCase() === owner &&
      r.repoName?.toLowerCase() === repo &&
      repoOnHost(r, trackerHost, scope.instanceBaseUrl)
  );
}

/**
 * {@link TrackerRepoScope} for repositories already in hand (the ones a request targets). The
 * operator's extra repositories are the union of each repository's own scope (its team and
 * organization): the request targets every one of them, so none outranks another and the result
 * does not depend on their order.
 */
export async function repoTrackerScope(
  repos: ReadonlyArray<TrackerScopeRepo>,
  launchTeam?: TrackerLaunchSource
): Promise<TrackerRepoScope> {
  return {
    extraRepos: [
      ...new Set((await Promise.all(repos.map((repo) => resolveRepoIssueRepos(repo)))).flat()),
    ],
    instanceBaseUrl: await resolveGitHubBaseUrl(),
    repos,
    ...(await resolveProjectKeyScope(repos, launchTeam)),
  };
}

/**
 * May a tracker READ fetch this user-supplied ticket id? Only the GitHub tracker is gated: its id
 * names its own `owner/repo`, and the platform's token reads any repository it can see, so the id
 * must name a repository the request or run targets, on the tracker's host, or one the operator
 * listed in `github.trackerIssueRepositories`. Jira and Linear ids name no repository; they are
 * gated by `github.trackerAllowedProjectKeys` (empty: unrestricted, else the id's project key must
 * be listed, case-insensitively, and an unparseable id is refused). Other providers are not gated.
 * A failed scope load refuses, so this never throws; the caller asks before any network call.
 */
export async function isTrackerReadInScope(
  config: { provider: string | null; baseUrl?: string | null },
  ticketId: string,
  loadScope: () => Promise<TrackerRepoScope>,
  defaultRepo?: { owner: string; repo: string }
): Promise<boolean> {
  const gated = config.provider === 'jira' || config.provider === 'linear';
  if (config.provider !== 'github' && !gated) {
    return true;
  }
  try {
    const scope = await loadScope();
    if (!gated) {
      return isGitHubTicketInScope(ticketId, config.baseUrl, scope, defaultRepo);
    }
    return !scope.projectKeysUnreadable && isProjectKeyAllowed(scope, ticketId);
  } catch {
    return false;
  }
}

/**
 * Does the project-key allowlist of a loaded scope admit this Jira/Linear ticket id? Empty:
 * unrestricted; else the id's project key must be listed, case-insensitively, and an unparseable id
 * is refused. The caller has already ruled out `projectKeysUnreadable`.
 */
export function isProjectKeyAllowed(
  scope: Pick<TrackerRepoScope, 'allowedProjectKeys'>,
  ticketId: string
): boolean {
  const allowed = scope.allowedProjectKeys ?? [];
  if (allowed.length === 0) {
    return true;
  }
  const key = parseTrackerProjectKey(ticketId)?.toLowerCase();
  return key !== undefined && allowed.some((entry) => entry.toLowerCase() === key);
}

/**
 * May a tracker WRITE (a comment or a status transition) touch this ticket? The same decision as
 * {@link isTrackerReadInScope} with no default repository, which a write never resolves a bare
 * number against: Jira and Linear by `github.trackerAllowedProjectKeys` (same key parsing, union
 * rule and fail-closed handling), GitHub by the repositories the run targets. A named wrapper so
 * a write path reads as a write path; there is one rule, and a change to it changes both.
 */
export function isTrackerWriteInScope(
  config: { provider: string | null; baseUrl?: string | null },
  ticketId: string,
  loadScope: () => Promise<TrackerRepoScope>
): Promise<boolean> {
  return isTrackerReadInScope(config, ticketId, loadScope);
}

/** The line a refused GitHub-tracker read logs. Fixed: it never carries ticket text. */
export const TRACKER_READ_OUT_OF_SCOPE =
  "Tracker read skipped: the ticket's repository is not one this request targets or the operator allows";

const REPO_HOST_SELECT = {
  githubApiUrl: true,
  githubUrl: true,
  organizationName: true,
  repoName: true,
  team: { select: { orgId: true } },
  teamId: true,
} as const;

/** The run-input columns {@link runTrackerScope} reads; select them with this. */
export const RUN_TRACKER_SCOPE_SELECT = {
  connection: {
    select: { ...REPO_HOST_SELECT, type: true },
  },
  knowledgeRepoSources: true,
} as const;

/**
 * The repositories a run targets: its own connection when that is a git repository (a
 * connection of another type names no repository, whatever its org/repo columns say), plus every
 * git repository the launch was authorized against (`knowledgeRepoSources`, which an epic fills
 * for each target). The operator's extra repositories resolve at the run's own git connection's
 * team and organization; a run with no such connection has no team context and gets none.
 */
export async function runTrackerScope(
  run: {
    connection: (TrackerScopeRepo & { type: string }) | null;
    knowledgeRepoSources: unknown;
  },
  launchTeam?: TrackerLaunchSource
): Promise<TrackerRepoScope> {
  const repos: TrackerScopeRepo[] = [];
  if (run.connection?.type === 'git_repo') {
    repos.push(run.connection);
  }
  const repoIds = Array.isArray(run.knowledgeRepoSources)
    ? run.knowledgeRepoSources.flatMap((source: unknown) => {
        const id = (source as { repoId?: unknown } | null)?.repoId;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
  if (repoIds.length > 0) {
    const prisma = await db();
    const rows = await runUnscoped(
      'ids come from the launch-authorized run input; read only to compare a ticket repo',
      ['Connection'],
      () =>
        prisma.connection.findMany({
          select: REPO_HOST_SELECT,
          where: { id: { in: repoIds }, type: 'git_repo' },
        })
    );
    repos.push(...rows);
  }
  return {
    extraRepos: await resolveRepoIssueRepos(
      run.connection?.type === 'git_repo' ? run.connection : undefined
    ),
    instanceBaseUrl: await resolveGitHubBaseUrl(),
    repos,
    ...(await resolveProjectKeyScope(repos.length > 0 ? repos : [undefined], launchTeam)),
  };
}

/**
 * The platform user who launched the run, as a value or a way to read it. A worker passes
 * `currentRunLauncherId` (the launcher of the current execution); `null` is "no launcher" and
 * resolves at GLOBAL only. Omitted, the newest run row of the request names it, for a caller
 * (a webhook) that is not inside an execution.
 */
export type RunLauncherRef = string | null | (() => Promise<string | null>);

/**
 * The teams a user belongs to, with each team's organization, as launch contexts. Only ACTIVE
 * teams whose organization is active count (the one rule every launch-context lookup applies); a
 * member of an organization with no team of their own has no context here and resolves at GLOBAL.
 * Throws on a database failure; the scope loaders' callers treat that as a refusal.
 */
export async function loadUserTrackerTeams(userId: string): Promise<TrackerLaunchTeam[]> {
  const prisma = await db();
  const rows = await runUnscoped(
    "the launcher's own memberships, to resolve the tracker project allowlist at their teams",
    ['TeamMembership'],
    () =>
      prisma.teamMembership.findMany({
        select: { team: { select: { orgId: true } }, teamId: true },
        where: { team: { isActive: true, organization: { isActive: true } }, userId },
      })
  );
  return rows.map((row) => ({ orgId: row.team.orgId ?? null, teamId: row.teamId }));
}

/**
 * The contexts a run with no git repository resolves the project-key allowlist at: the team of
 * the template it was launched from (its latest run), else the launcher's own active teams, else
 * none (GLOBAL only: a global template launched by no platform user, which is every service
 * principal's launch, since `launchedById` names users only). The launcher's team lists override
 * GLOBAL where they set one; GLOBAL is not unioned in. `launcher` is {@link RunLauncherRef}.
 * Throws on a database failure; the scope loaders' callers treat that as a refusal.
 */
export async function loadRunLaunchContexts(
  runInputId: string,
  launcher?: RunLauncherRef
): Promise<TrackerLaunchTeam[]> {
  const prisma = await db();
  const run = await prisma.workflowRun.findFirst({
    orderBy: { startedAt: 'desc' },
    select: {
      launchedById: true,
      template: { select: { team: { select: { orgId: true } }, teamId: true } },
    },
    where: { workRequestId: runInputId },
  });
  const template = run?.template;
  if (template?.teamId) {
    return [{ orgId: template.team?.orgId ?? null, teamId: template.teamId }];
  }
  const launcherId =
    launcher === undefined
      ? (run?.launchedById ?? null)
      : typeof launcher === 'function'
        ? await launcher()
        : launcher;
  return launcherId ? loadUserTrackerTeams(launcherId) : [];
}

/**
 * {@link runTrackerScope} for a run input by id; no repositories when there is no such row. The
 * launch contexts are {@link loadRunLaunchContexts}, with `opts.launcher` as the launcher.
 */
export async function loadRunTrackerScope(
  runInputId: string,
  opts?: { launcher?: RunLauncherRef }
): Promise<TrackerRepoScope> {
  const prisma = await db();
  const run = await prisma.runInput.findUnique({
    select: RUN_TRACKER_SCOPE_SELECT,
    where: { id: runInputId },
  });
  if (!run) {
    return {
      allowedProjectKeys: [],
      instanceBaseUrl: await resolveGitHubBaseUrl(),
      projectKeysUnreadable: true,
      repos: [],
    };
  }
  // Lazy: the launch contexts are read only if a targeted repository names no team.
  return runTrackerScope(run, () => loadRunLaunchContexts(runInputId, opts?.launcher));
}

/** The line a refused GitHub-tracker sync logs. Fixed: it never carries ticket text. */
export const TRACKER_SYNC_OUT_OF_SCOPE =
  "Tracker sync skipped: the ticket's repository is not one this run targets or the operator allows";

/** The line a GitHub-tracker sync logs when the ticket id resolves to no repository. Fixed: never ticket text. */
export const TRACKER_SYNC_NO_REPOSITORY =
  'Tracker sync skipped: the ticket id names no repository this run can write to';

/** The line a failed tracker sync logs. Fixed: it never carries an error or ticket text. */
export const TRACKER_SYNC_FAILED = 'Tracker sync failed; continuing';

/** A scope that carries only the project-key allowlist at GLOBAL: a Jira/Linear write naming no run. */
async function globalProjectKeyScope(): Promise<TrackerRepoScope> {
  return { instanceBaseUrl: '', repos: [], ...(await resolveProjectKeyScope([undefined])) };
}

/** The line a Jira/Linear sync logs when the ticket's project is not allowed. Fixed: never ticket text. */
export const TRACKER_SYNC_PROJECT_OUT_OF_SCOPE =
  "Tracker sync skipped: the ticket's project is not one the operator allows for this run";

export interface SyncTrackerOptions {
  /**
   * The run's launcher, for a Jira/Linear write on a run with no repository and no template team
   * (see {@link RunLauncherRef}). A worker passes `currentRunLauncherId`.
   */
  launcher?: RunLauncherRef;
  /**
   * The run's `RunInput.id`. On the GitHub tracker the write goes only to a repository this run
   * targets; with no id there is no such repository, and nothing is written.
   */
  runInputId: string | null | undefined;
  /** Receives {@link TRACKER_SYNC_OUT_OF_SCOPE}, {@link TRACKER_SYNC_NO_REPOSITORY} and {@link TRACKER_SYNC_FAILED}. */
  warn?: (message: string, meta: Record<string, unknown>) => void;
  /** The provider's logger. Its warnings carry the raw provider error. */
  log?: { warn: (obj: unknown, msg?: string) => void };
  /**
   * Called once with the whole outcome, the failure the call resolves and whether any write
   * reached the ticket. Optional: a caller that only needs the failure class ignores it.
   */
  onOutcome?: (outcome: TrackerSyncOutcome) => void;
}

/**
 * Mirrors a run event onto its ticket. Resolves the class of the first write the tracker refused
 * (a comment, a status transition or a link; never its text), `'out_of_scope'` when the
 * repository check declined a GitHub write, `'no_repository'` when no repository could be resolved from a GitHub id (a bare number, a URL, a
 * foreign key),
 * `'no_transition'` when no transition to a status named like the target was found on a Jira ticket, `'unknown'` when the sync
 * itself failed, and null otherwise (including events that write nothing). `opts.onOutcome`
 * additionally reports whether anything was written.
 */
export async function syncTrackerOnEvent(
  event: TrackerSyncEvent,
  config: ResolvedIssueTrackerConfig,
  opts: SyncTrackerOptions
): Promise<TicketFailureClass | null> {
  const outcome = await syncTrackerOutcome(event, config, opts);
  try {
    opts.onOutcome?.(outcome);
  } catch {
    // A reporting sink must not change the sync's result.
  }
  return outcome.failure;
}

async function syncTrackerOutcome(
  event: TrackerSyncEvent,
  config: ResolvedIssueTrackerConfig,
  opts: SyncTrackerOptions
): Promise<TrackerSyncOutcome> {
  try {
    // Every other GitHub sync writes (a comment, a PR link posted as one, or closing the issue),
    // and the ticket id is user-supplied; Jira and Linear ids name no repository. Starting a
    // workflow writes nothing on GitHub (it has no 'In Progress' transition), so it needs no check.
    if (config.provider === 'github') {
      if (event.type === 'workflow_started') {
        return { failure: null, wrote: false };
      }
      const scope = opts.runInputId ? await loadRunTrackerScope(opts.runInputId) : null;
      if (!scope || !isGitHubTicketInScope(event.issueId, config.baseUrl, scope)) {
        // An id that parses to a repository is `out_of_scope`: "a repository this run does not
        // target" is true. Anything `parseGitHubTicketId` cannot parse without a default
        // repository (`123`, `#123`, an issue URL, `owner/repo`, another tracker's key) is
        // `no_repository`: a write never resolves it against a default, so it is unwritten, and
        // said so.
        const outOfScope = parseGitHubTicketId(event.issueId) !== null;
        (opts.warn ?? console.warn)(
          outOfScope ? TRACKER_SYNC_OUT_OF_SCOPE : TRACKER_SYNC_NO_REPOSITORY,
          { event: event.type, runInputId: opts.runInputId ?? null }
        );
        return { failure: outOfScope ? 'out_of_scope' : 'no_repository', wrote: false };
      }
    }
    // Jira and Linear ids name no repository, so a write is held to the project allowlist a read
    // is: a run launched for a ticket outside its team's projects writes nothing to it. A scope
    // that cannot be loaded or read is a fault, not a refusal: it writes nothing either (fail
    // closed) but resolves `unknown`, so a transient failure never reads as a policy decision.
    if (config.provider === 'jira' || config.provider === 'linear') {
      const scope = opts.runInputId
        ? await loadRunTrackerScope(opts.runInputId, { launcher: opts.launcher })
        : await globalProjectKeyScope();
      if (scope.projectKeysUnreadable) {
        (opts.warn ?? console.warn)(TRACKER_SYNC_FAILED, {
          event: event.type,
          runInputId: opts.runInputId ?? null,
        });
        return { failure: 'unknown', wrote: false };
      }
      if (!isProjectKeyAllowed(scope, event.issueId)) {
        (opts.warn ?? console.warn)(TRACKER_SYNC_PROJECT_OUT_OF_SCOPE, {
          event: event.type,
          runInputId: opts.runInputId ?? null,
        });
        return { failure: 'out_of_scope', wrote: false };
      }
    }
    const provider = createIssueTrackerProvider(config, { log: opts.log });
    if (!provider) {
      return { failure: null, wrote: false };
    }
    if (provider.syncOnEventOutcome) {
      const outcome = await provider.syncOnEventOutcome(event);
      return { failure: outcome.failure ?? null, wrote: outcome.wrote };
    }
    // A provider that cannot say what it wrote is taken to have written.
    return { failure: (await provider.syncOnEvent(event)) ?? null, wrote: true };
  } catch {
    // Reported through `warn`, the sink every caller passes. The error is not logged here: it can
    // carry provider text, and the provider's own `log` already reports what it chose to.
    (opts.warn ?? console.warn)(TRACKER_SYNC_FAILED, {
      event: event.type,
      runInputId: opts.runInputId ?? null,
    });
    return { failure: 'unknown', wrote: false };
  }
}

/**
 * Whether a request's ticket id names an issue in the tracker. An id the platform
 * generated (`RunInput.ticketIsSynthetic`: an agent run, a PRD run, a scheduled
 * fire, a launch that named no ticket) cannot exist there, so syncing it would
 * only produce failed calls. Absent a request or an id there is nothing to sync.
 */
export function isTrackerTicket(
  request:
    | { externalTicketId?: string | null; ticketIsSynthetic?: boolean | null }
    | null
    | undefined
): boolean {
  return !!request?.externalTicketId && !request.ticketIsSynthetic;
}
