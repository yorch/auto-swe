import { adfFromText, adfToPlainText } from '../adf.js';
import type { AtlassianClient } from '../atlassianClient.js';
import { AtlassianError } from '../atlassianClient.js';
import type { IssueTrackerProvider } from '../issueTracker.js';
import { JIRA_SYNC_STATUSES } from '../jiraSyncStatuses.js';
import { type TicketFailureClass, ticketFailureFromStatus } from '../ticketFailure.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  FetchIssueOutcome,
  FetchIssueResult,
  IssueComment,
  IssueCreateFields,
  IssueParent,
  SearchedIssue,
  SearchIssuesOptions,
  SearchIssuesResult,
  TrackerSyncEvent,
  TrackerSyncOutcome,
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
  issues?: {
    key?: string;
    fields?: { summary?: string; project?: { key?: string }; status?: { name?: string } };
  }[];
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

/** The failure class of an error thrown while reading an issue; never its text. */
function jiraFailure(err: unknown): TicketFailureClass {
  if (!(err instanceof AtlassianError)) {
    return 'unknown';
  }
  switch (err.code) {
    case 'auth':
    case 'not_found':
    case 'rate_limited':
    case 'redirect':
    case 'server':
      return ticketFailureFromStatus(err.status);
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
  }
}

/** `refused` for the one class that is the tracker's final word on the issue; see fetchIssueOutcome. */
export function jiraOutcomeKind(failure: TicketFailureClass): 'refused' | 'unavailable' {
  return failure === 'not_found' ? 'refused' : 'unavailable';
}

/**
 * The Jira status category (`new` | `indeterminate` | `done`) of each status the platform's sync
 * asks for, by lower-cased name. A target outside the sync set has no category and is compared by
 * name only.
 */
const SYNC_TARGET_CATEGORIES = new Map<string, string>([
  [JIRA_SYNC_STATUSES.completed.toLowerCase(), 'done'],
  [JIRA_SYNC_STATUSES.prOpened.toLowerCase(), 'indeterminate'],
  [JIRA_SYNC_STATUSES.started.toLowerCase(), 'indeterminate'],
]);

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
    return (await this.readIssue(id, opts)).issue;
  }

  async readIssue(id: string, opts?: FetchIssueOptions): Promise<FetchIssueResult> {
    try {
      return { issue: await this.loadIssue(id, opts) };
    } catch (err) {
      if (!(err instanceof AtlassianError && err.code === 'not_found')) {
        this.log?.warn({ err, issueId: id }, 'Jira fetchIssue failed');
      }
      return { failure: jiraFailure(err), issue: null };
    }
  }

  /**
   * {@link readIssue} for a caller that decides whether to try again, mapped from the failure
   * class so the tracker's answer is classified once:
   *
   * - `refused`, the tracker's definitive answer about this issue: `not_found`. Jira Cloud answers
   *   404 for an issue the credential may not see (issue-level security) or that no longer
   *   exists, and asking again changes nothing.
   * - `unavailable`, which a later try may change: every other class. A 403 is not read as a
   *   refusal of the issue: it is usually about the caller (a Data Center CAPTCHA lockout, an IP
   *   allowlist, a firewall). A 401 is a credential an operator can fix, and `rejected`,
   *   `rate_limited`, `server_error`, `timeout`, `network`, `redirect`, `refused` (the
   *   platform's network policy), `empty` and `unknown` are all conditions that pass or are fixed.
   */
  async fetchIssueOutcome(id: string, opts?: FetchIssueOptions): Promise<FetchIssueOutcome> {
    const read = await this.readIssue(id, opts);
    if (read.issue) {
      return { issue: read.issue, kind: 'found' };
    }
    return { kind: jiraOutcomeKind(read.failure) };
  }

  private async loadIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue> {
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
        fields: ['summary', 'project', 'status'],
        jql,
        maxResults: SEARCH_PAGE_SIZE,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const hit of response.issues ?? []) {
        const projectKey = hit.fields?.project?.key;
        if (hit.key && projectKey) {
          const status = hit.fields?.status?.name;
          issues.push({
            key: hit.key,
            projectKey,
            ...(status ? { status } : {}),
            summary: hit.fields?.summary ?? '',
          });
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
    await this.moveIssue(issueId, targetStatusName);
  }

  /**
   * Moves the issue to a status; resolves why the tracker refused (the read of its transitions or
   * the move), `no_transition` when no transition to a status named like it was found and the issue is not
   * already there, or null when it moved or is already in the status. `tally.wrote` is set only
   * when a transition was posted.
   */
  private async moveIssue(
    issueId: string,
    targetStatusName: string,
    tally?: { wrote: boolean }
  ): Promise<TicketFailureClass | null> {
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
        // Jira omits the self-transition, so an issue already in the target status has none to
        // it: healthy. Only an issue in another status is reported, and a status read that fails
        // or names none guesses nothing.
        // "Already there" is the same name, or the same status category: a project's done status
        // may be "Closed", "Resolved" or localized, and the category key does not change.
        const status = await this.readStatus(issueId);
        if (status === null) {
          return null;
        }
        const targetCategory = SYNC_TARGET_CATEGORIES.get(targetStatusName.toLowerCase());
        const alreadyThere =
          status.name.toLowerCase() === targetStatusName.toLowerCase() ||
          (status.category !== null &&
            targetCategory !== undefined &&
            status.category === targetCategory);
        return alreadyThere ? null : 'no_transition';
      }
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`, {
        transition: { id: transition.id },
      });
      if (tally) {
        tally.wrote = true;
      }
      return null;
    } catch (err) {
      this.log?.warn({ err, issueId, targetStatusName }, 'Jira transitionIssue failed');
      return jiraFailure(err);
    }
  }

  /** The issue's current status name and category key, or null when it cannot be read or names no status. */
  private async readStatus(
    issueId: string
  ): Promise<{ category: string | null; name: string } | null> {
    try {
      const issue = await this.client.get<{
        fields?: { status?: { name?: unknown; statusCategory?: { key?: unknown } } };
      }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=status`);
      const name = issue.fields?.status?.name;
      if (typeof name !== 'string' || !name) {
        return null;
      }
      const category = issue.fields?.status?.statusCategory?.key;
      return { category: typeof category === 'string' && category ? category : null, name };
    } catch {
      return null;
    }
  }

  async addComment(issueId: string, bodyText: string): Promise<boolean> {
    return (await this.postComment(issueId, bodyText)) === null;
  }

  /** Posts a comment; resolves why the tracker refused it, or null when it took it. */
  private async postComment(issueId: string, bodyText: string): Promise<TicketFailureClass | null> {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
        body: adfFromText(bodyText),
      });
      return null;
    } catch (err) {
      this.log?.warn({ err, issueId }, 'Jira addComment failed');
      return jiraFailure(err);
    }
  }

  async addRemoteLink(issueId: string, url: string, title: string): Promise<void> {
    await this.postRemoteLink(issueId, url, title);
  }

  /** Links a URL to the issue; resolves why the tracker refused it, or null when it took it. */
  private async postRemoteLink(
    issueId: string,
    url: string,
    title: string
  ): Promise<TicketFailureClass | null> {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/remotelink`, {
        object: { title, url },
      });
      return null;
    } catch (err) {
      this.log?.warn({ err, issueId, title, url }, 'Jira addRemoteLink failed');
      return jiraFailure(err);
    }
  }

  /**
   * Mirrors a run event onto the issue. Every write of the event is attempted; resolves the class
   * of the first one the tracker refused (comment, status move or link), or null.
   */
  async syncOnEvent(event: TrackerSyncEvent): Promise<TicketFailureClass | null> {
    return (await this.syncOnEventOutcome(event)).failure;
  }

  /** {@link syncOnEvent} that also says whether any write reached the ticket. */
  async syncOnEventOutcome(event: TrackerSyncEvent): Promise<TrackerSyncOutcome> {
    let failure: TicketFailureClass | null = null;
    let wrote = false;
    const tally = { wrote: false };
    const note = (refused: TicketFailureClass | null) => {
      failure ??= refused;
    };
    // A comment or link that resolves null was written; a status move reports through `tally`.
    const noteWrite = (refused: TicketFailureClass | null) => {
      note(refused);
      wrote ||= refused === null;
    };
    try {
      switch (event.type) {
        case 'workflow_started':
          note(await this.moveIssue(event.issueId, JIRA_SYNC_STATUSES.started, tally));
          break;
        case 'pr_opened':
          if (event.prUrl && event.prTitle) {
            noteWrite(await this.postRemoteLink(event.issueId, event.prUrl, event.prTitle));
          }
          note(await this.moveIssue(event.issueId, JIRA_SYNC_STATUSES.prOpened, tally));
          break;
        case 'ci_passed':
          noteWrite(await this.postComment(event.issueId, '✅ CI passed'));
          break;
        case 'ci_failed':
          noteWrite(
            await this.postComment(
              event.issueId,
              `❌ CI failed${event.summary ? `: ${event.summary}` : ''}`
            )
          );
          break;
        case 'workflow_completed':
          if (event.prUrl && event.prTitle) {
            noteWrite(await this.postRemoteLink(event.issueId, event.prUrl, event.prTitle));
          }
          note(await this.moveIssue(event.issueId, JIRA_SYNC_STATUSES.completed, tally));
          break;
        case 'workflow_failed':
          noteWrite(
            await this.postComment(
              event.issueId,
              `⚠️ Workflow failed${event.summary ? `: ${event.summary}` : ''}`
            )
          );
          break;
      }
    } catch (err) {
      this.log?.warn({ err, event }, 'Jira syncOnEvent failed');
    }
    return { failure, wrote: wrote || tally.wrote };
  }
}
