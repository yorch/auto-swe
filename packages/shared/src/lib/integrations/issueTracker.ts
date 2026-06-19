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
  addComment(issueId: string, bodyText: string): Promise<void>;
  addRemoteLink(issueId: string, url: string, title: string): Promise<void>;
  syncOnEvent(event: TrackerSyncEvent): Promise<void>;
}
