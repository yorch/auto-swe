import type { TicketFailureClass } from './ticketFailure.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  FetchIssueOutcome,
  FetchIssueResult,
  IssueCreateFields,
  SearchIssuesOptions,
  SearchIssuesResult,
  TrackerSyncEvent,
  TrackerSyncOutcome,
} from './types.js';

export interface IssueTrackerProvider {
  fetchIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue | null>;
  /**
   * {@link fetchIssue} that says why it found nothing. Optional: a provider that does not tell a
   * refused issue from an unreachable tracker leaves it out, and a caller reads its `null` as
   * unavailable.
   */
  fetchIssueOutcome?(id: string, opts?: FetchIssueOptions): Promise<FetchIssueOutcome>;
  /** `fetchIssue` that also says why a ticket could not be read; never throws. */
  readIssue(id: string, opts?: FetchIssueOptions): Promise<FetchIssueResult>;
  createIssue(fields: IssueCreateFields): Promise<CreatedIssue | null>;
  /** Issues matching a tracker query (JQL for Jira). A tracker's own rejection of the query is thrown. */
  searchIssues(query: string, opts: SearchIssuesOptions): Promise<SearchIssuesResult>;
  transitionIssue(issueId: string, targetStatusName: string): Promise<void>;
  /** True when the tracker accepted the comment. A failure is logged and reported, never thrown. */
  addComment(issueId: string, bodyText: string): Promise<boolean>;
  addRemoteLink(issueId: string, url: string, title: string): Promise<void>;
  /**
   * Mirrors a run event onto the ticket. Resolves the class of a comment the tracker refused
   * (never its text), or null when it took every comment or the event posts none. Transitions
   * are best-effort and are not reported; on GitHub and Linear a link is itself a comment, and is
   * not reported either.
   */
  syncOnEvent(event: TrackerSyncEvent): Promise<TicketFailureClass | null>;
  /**
   * {@link syncOnEvent} that also says whether any write reached the ticket. Optional: a provider
   * without it is treated as having written (it cannot say otherwise).
   */
  syncOnEventOutcome?(event: TrackerSyncEvent): Promise<TrackerSyncOutcome>;
}
