import { adfFromText, adfToPlainText } from '../adf.js';
import type { AtlassianClient } from '../atlassianClient.js';
import { AtlassianError } from '../atlassianClient.js';
import type { IssueTrackerProvider } from '../issueTracker.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  FetchIssueOutcome,
  IssueComment,
  IssueCreateFields,
  IssueParent,
  SearchedIssue,
  SearchIssuesOptions,
  SearchIssuesResult,
  TrackerSyncEvent,
} from '../types.js';

interface JiraProviderConfig {
  storyPointsFieldId?: string | null;
  epicIssueType?: string | null;
  storyIssueType?: string | null;
  defaultProjectKey?: string | null;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

interface JiraIssueResponse {
  key?: string;
  id?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    labels?: string[];
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    components?: { name?: string }[];
    parent?: {
      key?: string;
      fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } };
    };
  };
}

interface JiraCommentsResponse {
  comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[];
}

/// Comments read per ticket: the newest, which is where the latest decisions are.
const MAX_COMMENTS = 20;

interface JiraTransitionResponse {
  transitions?: { id: string; name: string; to?: { name?: string } }[];
}

interface JiraRemoteLink {
  object?: { url?: string };
}

interface JiraSearchResponse {
  issues?: { key?: string; fields?: { summary?: string; project?: { key?: string } } }[];
  nextPageToken?: string;
  isLast?: boolean;
}

/// Matches asked of Jira per page; the search endpoint allows up to 5000 but 100 keeps a page small.
const SEARCH_PAGE_SIZE = 100;

/// Pages read before giving up. Pages of unusable rows never grow the result, so the match cap
/// alone cannot end a search against a Jira that keeps handing out tokens.
const MAX_SEARCH_PAGES = 100;

interface JiraCreateResponse {
  id: string;
  key: string;
  self: string;
}

export class JiraProvider implements IssueTrackerProvider {
  private readonly storyPointsFieldId: string;
  private readonly epicIssueType: string;
  private readonly storyIssueType: string;
  private readonly defaultProjectKey: string;
  private readonly log: { warn: (obj: unknown, msg?: string) => void } | undefined;

  constructor(
    private readonly client: AtlassianClient,
    config: JiraProviderConfig
  ) {
    this.storyPointsFieldId = config.storyPointsFieldId ?? 'story_points';
    this.epicIssueType = config.epicIssueType ?? 'Epic';
    this.storyIssueType = config.storyIssueType ?? 'Story';
    this.defaultProjectKey = config.defaultProjectKey ?? 'BACKLOG';
    this.log = config.log;
  }

  async fetchIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue | null> {
    try {
      return await this.readIssue(id, opts);
    } catch (err) {
      if (err instanceof AtlassianError && err.code === 'not_found') {
        return null;
      }
      this.log?.warn({ err, issueId: id }, 'Jira fetchIssue failed');
      return null;
    }
  }

  /**
   * {@link fetchIssue} with the reason for a miss. Jira answers 403 or 404 for an issue the
   * credential may not see (issue-level security) or that no longer exists: that answer is about
   * the issue, and asking again changes nothing, so it is `refused`. Anything else (a 5xx, a
   * timeout, a rate limit, a rejected credential, a response that does not parse) is
   * `unavailable`, which a caller retries later.
   */
  async fetchIssueOutcome(id: string, opts?: FetchIssueOptions): Promise<FetchIssueOutcome> {
    try {
      return { issue: await this.readIssue(id, opts), kind: 'found' };
    } catch (err) {
      if (err instanceof AtlassianError && (err.status === 403 || err.status === 404)) {
        return { kind: 'refused' };
      }
      this.log?.warn({ err, issueId: id }, 'Jira fetchIssue failed');
      return { kind: 'unavailable' };
    }
  }

  private async readIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue> {
    const issue = await this.client.get<JiraIssueResponse>(
      `/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,description,status,labels,priority,assignee,components${opts?.includeParent ? ',parent' : ''}`
    );

    // Fetch remote links to find linked Confluence pages — gated behind
    // opts.fetchLinkedPages to avoid an unconditional extra round-trip for
    // callers that have no knowledge base configured.
    let linkedPageIds: string[] = [];
    if (opts?.fetchLinkedPages) {
      try {
        const remoteLinks = await this.client.get<JiraRemoteLink[]>(
          `/rest/api/3/issue/${encodeURIComponent(id)}/remotelink`
        );
        linkedPageIds = (remoteLinks ?? [])
          .map((rl) => rl.object?.url ?? '')
          .filter((url) => url.includes('/wiki/'))
          .map((url) => {
            const match = /\/pages\/(\d+)/.exec(url);
            return match?.[1] ?? '';
          })
          .filter(Boolean);
      } catch {
        // Remote links are optional — ignore errors
      }
    }

    const comments = opts?.includeComments ? await this.readComments(id) : undefined;
    const parent = opts?.includeParent ? await this.readParent(issue) : undefined;

    return {
      assignee: issue.fields?.assignee?.displayName ?? undefined,
      ...(comments ? { comments } : {}),
      components: (issue.fields?.components ?? []).map((c) => c.name ?? '').filter(Boolean),
      description: adfToPlainText(issue.fields?.description).trim(),
      id: issue.key ?? id,
      labels: issue.fields?.labels ?? [],
      linkedPageIds: linkedPageIds.length > 0 ? linkedPageIds : undefined,
      ...(parent ? { parent } : {}),
      priority: issue.fields?.priority?.name ?? undefined,
      raw: issue,
      status: issue.fields?.status?.name ?? 'unknown',
      title: issue.fields?.summary ?? id,
      url: `${this.client.baseUrl}/browse/${encodeURIComponent(issue.key ?? id)}`,
    };
  }

  /// The newest comments, oldest first. Optional: a failure leaves the ticket without them.
  private async readComments(id: string): Promise<IssueComment[] | undefined> {
    try {
      const res = await this.client.get<JiraCommentsResponse>(
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment?maxResults=${MAX_COMMENTS}&orderBy=-created`
      );
      const comments = (res.comments ?? [])
        .map((c) => ({
          author: c.author?.displayName ?? 'unknown',
          body: adfToPlainText(c.body).trim(),
          created: c.created ?? '',
        }))
        .filter((c) => c.body !== '')
        .reverse();
      return comments.length > 0 ? comments : undefined;
    } catch (err) {
      this.log?.warn({ err, issueId: id }, 'Jira comments unavailable');
      return undefined;
    }
  }

  /// The issue's parent (an epic, usually). The description needs a second read, which is
  /// optional: without it the parent keeps its title, status and type.
  private async readParent(issue: JiraIssueResponse): Promise<IssueParent | undefined> {
    const parent = issue.fields?.parent;
    const key = parent?.key;
    if (!key) {
      return undefined;
    }
    let description = '';
    try {
      const full = await this.client.get<JiraIssueResponse>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status`
      );
      description = adfToPlainText(full.fields?.description).trim();
    } catch (err) {
      this.log?.warn({ err, issueId: key }, 'Jira parent description unavailable');
    }
    return {
      description,
      id: key,
      status: parent.fields?.status?.name ?? 'unknown',
      title: parent.fields?.summary ?? key,
      type: parent.fields?.issuetype?.name ?? 'unknown',
    };
  }

  async createIssue(fields: IssueCreateFields): Promise<CreatedIssue | null> {
    try {
      const body: Record<string, unknown> = {
        fields: {
          description: adfFromText(fields.description),
          issuetype: { name: fields.issueType },
          project: { key: fields.projectKey || this.defaultProjectKey },
          summary: fields.title,
          ...(fields.storyPoints ? { [this.storyPointsFieldId]: fields.storyPoints } : {}),
          ...(fields.parentId ? { parent: { id: fields.parentId } } : {}),
        },
      };

      const created = await this.client.post<JiraCreateResponse>('/rest/api/3/issue', body);

      return {
        id: created.id,
        title: fields.title,
        type: fields.issueType === this.epicIssueType ? 'epic' : 'story',
        url: `${this.client.baseUrl}/browse/${created.key}`,
      };
    } catch (err) {
      this.log?.warn({ err, fields }, 'Jira createIssue failed');
      return null;
    }
  }

  async searchIssues(jql: string, opts: SearchIssuesOptions): Promise<SearchIssuesResult> {
    const issues: SearchedIssue[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    // Not knowing the whole result is reported like a result that is too long: callers fail closed.
    let incomplete = false;
    // One match past the cap is enough to know the result was cut.
    for (let page = 0; issues.length <= opts.maxResults; page++) {
      if (page >= MAX_SEARCH_PAGES) {
        incomplete = true;
        break;
      }
      const response = await this.client.post<JiraSearchResponse>('/rest/api/3/search/jql', {
        fields: ['summary', 'project'],
        jql,
        maxResults: SEARCH_PAGE_SIZE,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const hit of response.issues ?? []) {
        const projectKey = hit.fields?.project?.key;
        if (hit.key && projectKey) {
          issues.push({ key: hit.key, projectKey, summary: hit.fields?.summary ?? '' });
        }
        if (issues.length > opts.maxResults) {
          break;
        }
      }
      if (response.isLast || !response.nextPageToken) {
        break;
      }
      if (seenTokens.has(response.nextPageToken)) {
        incomplete = true;
        break;
      }
      seenTokens.add(response.nextPageToken);
      nextPageToken = response.nextPageToken;
    }
    const truncated = incomplete || issues.length > opts.maxResults;
    return {
      issues: issues.length > opts.maxResults ? issues.slice(0, opts.maxResults) : issues,
      truncated,
    };
  }

  async transitionIssue(issueId: string, targetStatusName: string): Promise<void> {
    try {
      const result = await this.client.get<JiraTransitionResponse>(
        `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`
      );
      const transitions = result.transitions ?? [];
      const transition = transitions.find(
        (t) =>
          t.name.toLowerCase() === targetStatusName.toLowerCase() ||
          t.to?.name?.toLowerCase() === targetStatusName.toLowerCase()
      );
      if (!transition) {
        // No matching transition — silently no-op
        return;
      }
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`, {
        transition: { id: transition.id },
      });
    } catch (err) {
      this.log?.warn({ err, issueId, targetStatusName }, 'Jira transitionIssue failed');
    }
  }

  async addComment(issueId: string, bodyText: string): Promise<boolean> {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
        body: adfFromText(bodyText),
      });
      return true;
    } catch (err) {
      this.log?.warn({ err, issueId }, 'Jira addComment failed');
      return false;
    }
  }

  async addRemoteLink(issueId: string, url: string, title: string): Promise<void> {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/remotelink`, {
        object: { title, url },
      });
    } catch (err) {
      this.log?.warn({ err, issueId, title, url }, 'Jira addRemoteLink failed');
    }
  }

  async syncOnEvent(event: TrackerSyncEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'workflow_started':
          await this.transitionIssue(event.issueId, 'In Progress');
          break;
        case 'pr_opened':
          if (event.prUrl && event.prTitle) {
            await this.addRemoteLink(event.issueId, event.prUrl, event.prTitle);
          }
          await this.transitionIssue(event.issueId, 'In Review');
          break;
        case 'ci_passed':
          await this.addComment(event.issueId, '✅ CI passed');
          break;
        case 'ci_failed':
          await this.addComment(
            event.issueId,
            `❌ CI failed${event.summary ? `: ${event.summary}` : ''}`
          );
          break;
        case 'workflow_completed':
          if (event.prUrl && event.prTitle) {
            await this.addRemoteLink(event.issueId, event.prUrl, event.prTitle);
          }
          await this.transitionIssue(event.issueId, 'Done');
          break;
        case 'workflow_failed':
          await this.addComment(
            event.issueId,
            `⚠️ Workflow failed${event.summary ? `: ${event.summary}` : ''}`
          );
          break;
      }
    } catch (err) {
      this.log?.warn({ err, event }, 'Jira syncOnEvent failed');
    }
  }
}
