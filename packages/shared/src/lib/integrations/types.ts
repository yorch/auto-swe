export interface IssueComment {
  author: string;
  body: string;
  created: string;
}

/// The issue one level up (a Jira epic, say), read only when asked for.
export interface IssueParent {
  id: string;
  title: string;
  description: string;
  status: string;
  type: string;
}

export interface FetchedIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  labels: string[];
  url: string;
  priority?: string;
  assignee?: string;
  components?: string[];
  linkedPageIds?: string[]; // for knowledge base cross-linking (Jira remote links)
  /// Newest comments, oldest first; set only when `FetchIssueOptions.includeComments` was asked for.
  comments?: IssueComment[];
  /// Set only when `FetchIssueOptions.includeParent` was asked for and the issue has one.
  parent?: IssueParent;
  raw: unknown;
}

/// One match of a tracker search: enough to decide whether an issue is new, not its content.
export interface SearchedIssue {
  key: string;
  summary: string;
  projectKey: string;
}

export interface SearchIssuesOptions {
  /// Most matches wanted. A search with more is cut and reported as `truncated`.
  maxResults: number;
}

export interface SearchIssuesResult {
  issues: SearchedIssue[];
  /// True when more than `maxResults` issues matched; `issues` then holds the first `maxResults`.
  truncated: boolean;
}

export interface IssueCreateFields {
  title: string;
  description: string;
  issueType: string; // 'Epic' | 'Story' | provider-specific
  projectKey: string;
  parentId?: string;
  storyPoints?: number;
}

export interface CreatedIssue {
  id: string;
  url: string | null;
  type: 'epic' | 'story';
  title: string;
}

export interface TrackerSyncEvent {
  type:
    | 'workflow_started'
    | 'pr_opened'
    | 'ci_passed'
    | 'ci_failed'
    | 'workflow_completed'
    | 'workflow_failed';
  issueId: string; // the issue key/id from FetchedIssue.id
  prUrl?: string;
  prTitle?: string;
  summary?: string; // for ci_failed / workflow_failed reason
}

export interface KnowledgePage {
  id: string;
  title: string;
  spaceKey?: string;
  bodyText: string;
  url: string;
  lastModified?: string;
}

export interface PageCreateFields {
  title: string;
  bodyText: string;
  spaceKey: string;
  parentPageId?: string;
}

export interface CreatedPage {
  id: string;
  url: string;
}

export interface FetchIssueOptions {
  defaultRepo?: { owner: string; repo: string };
  fetchLinkedPages?: boolean;
  /// One extra round-trip: the newest comments (Jira only; other providers ignore it).
  includeComments?: boolean;
  /// One or two extra round-trips: the parent issue (Jira only; other providers ignore it).
  includeParent?: boolean;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/// What reading one issue came to. `refused` is the tracker's definitive answer about this issue
/// (not visible to the credential, or gone); `unavailable` is anything a later try may change.
export type FetchIssueOutcome =
  | { kind: 'found'; issue: FetchedIssue }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

export interface SearchOptions {
  maxPages?: number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/// A reference to a specific Figma design, parsed from a file/design URL.
/// `nodeIds` is empty when the URL points at a whole file with no `node-id`.
export interface FigmaDesignRef {
  fileKey: string;
  nodeIds: string[];
  url: string;
}

/// One node in a compact design summary — bounded, prose-friendly material the
/// agents can read without ingesting a full Figma document tree.
export interface FigmaNodeSummary {
  id: string;
  name: string;
  type: string;
  /// Direct child frame/component names (one level deep), capped.
  childNames: string[];
  /// Visible text strings under this node, capped.
  texts: string[];
}

/// The compact, bounded design context attached to a work request's
/// `ContextSnapshot.rawDesign`. Never the raw Figma payload — always summarized
/// server-side so it stays within the agents' context budget.
export interface FigmaDesignSummary {
  fileKey: string;
  url: string;
  fileName?: string;
  nodes: FigmaNodeSummary[];
  /// Resolved design tokens / variables encountered, when readable (Figma
  /// Variables are Enterprise-gated, so this is best-effort and often empty).
  tokens: { name: string; value: string }[];
  /// Set when only a partial summary could be produced (rate limit, 403, cap).
  truncated?: boolean;
}

export interface FigmaFetchOptions {
  /// Hard cap on summarized nodes (top-level requested ids are always kept).
  maxNodes?: number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}
