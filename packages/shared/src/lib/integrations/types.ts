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
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export interface SearchOptions {
  maxPages?: number;
  log?: { warn: (obj: unknown, msg?: string) => void };
}
