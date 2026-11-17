import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import {
  isTrackerReadInScope,
  repoTrackerScope,
  TRACKER_READ_OUT_OF_SCOPE,
  type TrackerLaunchScope,
  type TrackerScopeRepo,
} from '@auto-swe/shared/lib/trackerSync';
import { type FetchedTicket, fetchTicket } from './issueTrackerClient.js';

type Log = { warn: (obj: unknown, msg?: string) => void };

/** The repository a ticket is read for; null when the request targets none. */
export type TicketReadRepo = TrackerScopeRepo & { organizationName: string; repoName: string };

/**
 * Is this ticket id one a tracker READ may fetch for this repository? The GitHub tracker's token
 * reads any repository it can see, so the id must name the selected repository on the tracker's
 * host or one the operator listed. Jira and Linear ids are gated by the project-key allowlist,
 * resolved at the repository's team, or, when the request targets no repository, at the launching
 * template's team or the launcher's teams (`launchTeam`). Never throws.
 */
export async function isTicketReadInScope(
  tracker: { baseUrl?: string | null; provider: string | null },
  ticketId: string,
  repo: TicketReadRepo | null,
  launchTeam?: TrackerLaunchScope
): Promise<boolean> {
  return isTrackerReadInScope(
    tracker,
    ticketId,
    () => repoTrackerScope(repo ? [repo] : [], launchTeam),
    repo ? { owner: repo.organizationName, repo: repo.repoName } : undefined
  );
}

export type TicketLookup =
  | { state: 'unconfigured' }
  /** Out of scope, missing, or the fetch failed: deliberately one answer. */
  | { state: 'not_found' }
  | { state: 'found'; ticket: FetchedTicket }
  /** The read itself broke (config decrypt, database, network): not the same as "not set up". */
  | { state: 'error' };

/** Options for {@link lookupTrackerTicket}. */
export interface TicketLookupOptions {
  /** The launching template's team, or the launcher's teams, for a request with no repository (see `repoTrackerScope`). */
  launchTeam?: TrackerLaunchScope;
  /** Retries per request for providers that retry (Jira). */
  maxRetries?: number;
  /**
   * A time budget for the whole read: the per-request timeout of providers that take one (Jira),
   * and a deadline over the read itself for every provider, which ends it as `error`.
   */
  timeoutMs?: number;
}

/**
 * Read one ticket from the configured tracker for a caller that is not waiting on enrichment:
 * the template-run brief and the launch form's preview. Never throws and never carries provider
 * error text — no tracker set up is "unconfigured", a refused read or a missing ticket is
 * "not_found", and anything that threw (config, database, fetch) or overran `timeoutMs` is "error".
 */
export async function lookupTrackerTicket(
  ticketId: string,
  repo: TicketReadRepo | null,
  log?: Log,
  opts?: TicketLookupOptions
): Promise<TicketLookup> {
  const read = readTrackerTicket(ticketId, repo, log, opts);
  if (opts?.timeoutMs === undefined) {
    return read;
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<TicketLookup>((resolve) => {
    timer = setTimeout(() => {
      log?.warn({}, 'Tracker lookup timed out');
      resolve({ state: 'error' });
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readTrackerTicket(
  ticketId: string,
  repo: TicketReadRepo | null,
  log?: Log,
  opts?: TicketLookupOptions
): Promise<TicketLookup> {
  try {
    const tracker = await resolveIssueTrackerConfig();
    if (!tracker.provider) {
      return { state: 'unconfigured' };
    }
    if (!(await isTicketReadInScope(tracker, ticketId, repo, opts?.launchTeam))) {
      log?.warn({}, TRACKER_READ_OUT_OF_SCOPE);
      return { state: 'not_found' };
    }
    const ticket = await fetchTicket(tracker, ticketId, {
      ...(repo ? { defaultRepo: { owner: repo.organizationName, repo: repo.repoName } } : {}),
      ...(log ? { log } : {}),
      ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return ticket ? { state: 'found', ticket } : { state: 'not_found' };
  } catch (err) {
    log?.warn({ err }, 'Tracker lookup failed');
    return { state: 'error' };
  }
}
