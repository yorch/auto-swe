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
}

/** The repositories a run targets, and where a repository with no URL override lives. */
export interface TrackerRepoScope {
  /** The instance's GitHub web URL (`resolveGitHubBaseUrl`). */
  instanceBaseUrl: string;
  repos: ReadonlyArray<TrackerScopeRepo>;
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
 * is anything whose host does not parse.
 */
export function isGitHubTicketInScope(
  ticketId: string,
  trackerBaseUrl: string | null | undefined,
  scope: TrackerRepoScope
): boolean {
  const parsed = parseGitHubTicketId(ticketId);
  const trackerHost = httpHostFamily(trackerBaseUrl ?? GITHUB_ISSUES_DEFAULT_BASE_URL);
  if (!parsed || !trackerHost) {
    return false;
  }
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();
  return scope.repos.some(
    (r) =>
      r.organizationName?.toLowerCase() === owner &&
      r.repoName?.toLowerCase() === repo &&
      repoOnHost(r, trackerHost, scope.instanceBaseUrl)
  );
}

const REPO_HOST_SELECT = {
  githubApiUrl: true,
  githubUrl: true,
  organizationName: true,
  repoName: true,
} as const;

/** The run-input columns {@link runTrackerScope} reads; select them with this. */
export const RUN_TRACKER_SCOPE_SELECT = {
  connection: { select: { ...REPO_HOST_SELECT, type: true } },
  knowledgeRepoSources: true,
} as const;

/**
 * The repositories a run targets: its own connection when that is a git repository (a
 * connection of another type names no repository, whatever its org/repo columns say), plus every
 * git repository the launch was authorized against (`knowledgeRepoSources`, which an epic fills
 * for each target).
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
  return { instanceBaseUrl: await resolveGitHubBaseUrl(), repos };
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
  "Tracker sync skipped: the ticket's repository is not one this run targets";

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
