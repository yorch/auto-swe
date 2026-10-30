import { resolveSetting, type SettingResolveCtx } from '../config/index.js';
import { hostFamily } from './githubHostScope.js';
import {
  GITHUB_ISSUES_DEFAULT_BASE_URL,
  parseGitHubTicketId,
} from './integrations/providers/githubIssues.js';
import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import { createIssueTrackerProvider } from './integrations/registry.js';
import type { TrackerSyncEvent } from './integrations/types.js';
import { resolveGitHubBaseUrl } from './systemConfig.js';
import { runUnscoped } from './tenantGuard.js';

export type { TrackerSyncEvent };

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
  repos: ReadonlyArray<TrackerScopeRepo>
): Promise<TrackerRepoScope> {
  return {
    extraRepos: [
      ...new Set((await Promise.all(repos.map((repo) => resolveRepoIssueRepos(repo)))).flat()),
    ],
    instanceBaseUrl: await resolveGitHubBaseUrl(),
    repos,
  };
}

/**
 * May a tracker READ fetch this user-supplied ticket id? Only the GitHub tracker is gated: its id
 * names its own `owner/repo`, and the platform's token reads any repository it can see, so the id
 * must name a repository the request or run targets, on the tracker's host, or one the operator
 * listed in `github.trackerIssueRepositories`. Jira and Linear ids
 * name no repository. The scope loads only for GitHub and a failed load refuses, so this never
 * throws; the caller asks before any network call.
 */
export async function isTrackerReadInScope(
  config: { provider: string | null; baseUrl?: string | null },
  ticketId: string,
  loadScope: () => Promise<TrackerRepoScope>,
  defaultRepo?: { owner: string; repo: string }
): Promise<boolean> {
  if (config.provider !== 'github') {
    return true;
  }
  try {
    return isGitHubTicketInScope(ticketId, config.baseUrl, await loadScope(), defaultRepo);
  } catch {
    return false;
  }
}

/** The line a refused GitHub-tracker read logs. Fixed: it never carries ticket text. */
export const TRACKER_READ_OUT_OF_SCOPE =
  "Tracker read skipped: the ticket's repository is not one this request targets or the operator allows";

const REPO_HOST_SELECT = {
  githubApiUrl: true,
  githubUrl: true,
  organizationName: true,
  repoName: true,
} as const;

/** The run-input columns {@link runTrackerScope} reads; select them with this. */
export const RUN_TRACKER_SCOPE_SELECT = {
  connection: {
    select: { ...REPO_HOST_SELECT, team: { select: { orgId: true } }, teamId: true, type: true },
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
export async function runTrackerScope(run: {
  connection: (TrackerScopeRepo & { type: string }) | null;
  knowledgeRepoSources: unknown;
}): Promise<TrackerRepoScope> {
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
  };
}

/** {@link runTrackerScope} for a run input by id; no repositories when there is no such row. */
export async function loadRunTrackerScope(runInputId: string): Promise<TrackerRepoScope> {
  const prisma = await db();
  const run = await prisma.runInput.findUnique({
    select: RUN_TRACKER_SCOPE_SELECT,
    where: { id: runInputId },
  });
  if (!run) {
    return { instanceBaseUrl: await resolveGitHubBaseUrl(), repos: [] };
  }
  return runTrackerScope(run);
}

/** The line a refused GitHub-tracker sync logs. Fixed: it never carries ticket text. */
export const TRACKER_SYNC_OUT_OF_SCOPE =
  "Tracker sync skipped: the ticket's repository is not one this run targets or the operator allows";

/** The line a failed tracker sync logs. Fixed: it never carries an error or ticket text. */
export const TRACKER_SYNC_FAILED = 'Tracker sync failed; continuing';

export interface SyncTrackerOptions {
  /**
   * The run's `RunInput.id`. On the GitHub tracker the write goes only to a repository this run
   * targets; with no id there is no such repository, and nothing is written.
   */
  runInputId: string | null | undefined;
  /** Receives {@link TRACKER_SYNC_OUT_OF_SCOPE} and {@link TRACKER_SYNC_FAILED}. */
  warn?: (message: string, meta: Record<string, unknown>) => void;
  /** The provider's logger. Its warnings carry the raw provider error. */
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export async function syncTrackerOnEvent(
  event: TrackerSyncEvent,
  config: ResolvedIssueTrackerConfig,
  opts: SyncTrackerOptions
): Promise<void> {
  try {
    // Every other GitHub sync writes (a comment, a PR link posted as one, or closing the issue),
    // and the ticket id is user-supplied; Jira and Linear ids name no repository. Starting a
    // workflow writes nothing on GitHub (it has no 'In Progress' transition), so it needs no check.
    if (config.provider === 'github') {
      if (event.type === 'workflow_started') {
        return;
      }
      const scope = opts.runInputId ? await loadRunTrackerScope(opts.runInputId) : null;
      if (!scope || !isGitHubTicketInScope(event.issueId, config.baseUrl, scope)) {
        (opts.warn ?? console.warn)(TRACKER_SYNC_OUT_OF_SCOPE, {
          event: event.type,
          runInputId: opts.runInputId ?? null,
        });
        return;
      }
    }
    const provider = createIssueTrackerProvider(config, { log: opts.log });
    if (!provider) {
      return;
    }
    await provider.syncOnEvent(event);
  } catch {
    // Reported through `warn`, the sink every caller passes. The error is not logged here: it can
    // carry provider text, and the provider's own `log` already reports what it chose to.
    (opts.warn ?? console.warn)(TRACKER_SYNC_FAILED, {
      event: event.type,
      runInputId: opts.runInputId ?? null,
    });
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
