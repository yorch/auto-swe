import { adfToPlainText as _adfToPlainText } from '@auto-swe/shared/lib/integrations/adf';
import { parseGitHubTicketId as _parseGitHubTicketId } from '@auto-swe/shared/lib/integrations/providers/githubIssues';
import {
  createIssueTrackerProvider,
  type ResolvedIssueTrackerConfig,
} from '@auto-swe/shared/lib/integrations/registry';

/**
 * Backwards-compatible thin wrapper over the provider abstraction layer.
 * The real implementations are now in `@auto-swe/shared/lib/integrations/providers/`.
 *
 * Failure policy: this module NEVER throws. Any failure (no provider, bad
 * config, network error, timeout, 404, unparsable body) logs a warning and
 * returns null — ticket enrichment is strictly best-effort and must never
 * block a submission.
 */

/** @deprecated Use `FetchedIssue` from `@auto-swe/shared/lib/integrations/types`. */
export interface FetchedTicket {
  title: string;
  description: string;
  status: string;
  labels: string[];
  url: string;
  /// Raw provider payload.
  raw: unknown;
}

/** @deprecated Use `FetchIssueOptions` from `@auto-swe/shared/lib/integrations/types`. */
export interface FetchTicketOptions {
  defaultRepo?: { owner: string; repo: string };
  fetchLinkedPages?: boolean;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/// Re-export for backwards compat — tests import this from issueTrackerClient.ts.
/// Re-export for backwards compat — tests import this from issueTrackerClient.ts.
export { _adfToPlainText as adfToPlainText, _parseGitHubTicketId as parseGitHubTicketId };

/// Thin delegation wrapper — delegates to the provider abstraction layer.
export async function fetchTicket(
  config: ResolvedIssueTrackerConfig,
  externalTicketId: string,
  opts?: FetchTicketOptions
): Promise<FetchedTicket | null> {
  try {
    const provider = createIssueTrackerProvider(config, {
      log: opts?.log,
    });
    if (!provider) {
      return null;
    }
    const issue = await provider.fetchIssue(externalTicketId, {
      defaultRepo: opts?.defaultRepo,
      fetchLinkedPages: opts?.fetchLinkedPages,
      log: opts?.log,
    });
    if (!issue) {
      return null;
    }
    // Map FetchedIssue → FetchedTicket for backwards compat
    return {
      description: issue.description,
      labels: issue.labels,
      raw: issue.raw,
      status: issue.status,
      title: issue.title,
      url: issue.url,
    };
  } catch (err) {
    opts?.log?.warn(
      { err, provider: config.provider, ticketId: externalTicketId },
      'Tracker fetch failed'
    );
    return null;
  }
}
