import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  IssueCreateFields,
  TrackerSyncEvent,
} from './types.js';

export interface IssueTrackerProvider {
  fetchIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue | null>;
  createIssue(fields: IssueCreateFields): Promise<CreatedIssue | null>;
  transitionIssue(issueId: string, targetStatusName: string): Promise<void>;
  /** True when the tracker accepted the comment. A failure is logged and reported, never thrown. */
  addComment(issueId: string, bodyText: string): Promise<boolean>;
  addRemoteLink(issueId: string, url: string, title: string): Promise<void>;
  syncOnEvent(event: TrackerSyncEvent): Promise<void>;
}
