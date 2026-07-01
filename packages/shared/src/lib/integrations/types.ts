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
  raw: unknown;
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
  log?: { warn: (obj: unknown, msg?: string) => void };
}

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
