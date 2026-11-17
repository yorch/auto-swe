import { buildTicketBrief } from '@auto-swe/shared/lib/ticketBrief';
import {
  lookupTrackerTicket,
  type TicketLookupOptions,
  type TicketReadRepo,
} from './ticketLookup.js';

type Log = { warn: (obj: unknown, msg?: string) => void };

/** The repository columns the tracker scope check reads (see `TicketReadRepo`). */
export type LaunchBriefConnection = Omit<TicketReadRepo, 'organizationName' | 'repoName'> & {
  organizationName: string | null;
  repoName: string | null;
};

export type LaunchBrief = { ok: true; description: string } | { ok: false };

/**
 * Build the fenced brief for a launch whose description was left blank, from the tracker ticket.
 * Call only after every authorization check has passed, so the tracker is read for a launch that
 * will go ahead. Never throws and never carries provider text: any failure is `{ ok: false }`.
 */
export async function resolveLaunchBrief(opts: {
  ticketId: string;
  connection?: LaunchBriefConnection | null;
  log?: Log;
  /** The launching template's team, for a launch with no git repository. */
  launchTeam?: TicketLookupOptions['launchTeam'];
  /** Retry and time budget of the tracker read, for a caller with a deadline of its own. */
  maxRetries?: number;
  timeoutMs?: number;
}): Promise<LaunchBrief> {
  try {
    const repo = opts.connection;
    const lookupOpts = {
      ...(opts.launchTeam ? { launchTeam: opts.launchTeam } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const lookupRepo =
      repo?.organizationName && repo.repoName
        ? { ...repo, organizationName: repo.organizationName, repoName: repo.repoName }
        : null;
    const found =
      Object.keys(lookupOpts).length > 0
        ? await lookupTrackerTicket(opts.ticketId, lookupRepo, opts.log, lookupOpts)
        : await lookupTrackerTicket(opts.ticketId, lookupRepo, opts.log);
    if (found.state !== 'found') {
      return { ok: false };
    }
    return { description: buildTicketBrief(opts.ticketId, found.ticket), ok: true };
  } catch (err) {
    opts.log?.warn({ err }, 'Launch brief failed');
    return { ok: false };
  }
}
