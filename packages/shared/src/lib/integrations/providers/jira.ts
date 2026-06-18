import { adfFromText, adfToPlainText } from '../adf.js';
import type { AtlassianClient } from '../atlassianClient.js';
import { AtlassianError } from '../atlassianClient.js';
import type { IssueTrackerProvider } from '../issueTracker.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  IssueCreateFields,
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
  };
}

interface JiraTransitionResponse {
  transitions?: { id: string; name: string; to?: { name?: string } }[];
}

interface JiraRemoteLink {
  object?: { url?: string };
}

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

  async fetchIssue(id: string, _opts?: FetchIssueOptions): Promise<FetchedIssue | null> {
    try {
      const issue = await this.client.get<JiraIssueResponse>(
        `/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,description,status,labels,priority,assignee,components`
      );

      // Fetch remote links to find linked Confluence pages
      let linkedPageIds: string[] = [];
      try {
        const remoteLinks = await this.client.get<JiraRemoteLink[]>(
          `/rest/api/3/issue/${encodeURIComponent(id)}/remotelink`
        );
        linkedPageIds = (remoteLinks ?? [])
          .map((rl) => rl.object?.url ?? '')
          .filter((url) => url.includes('/wiki/'))
          .map((url) => {
            // Extract page ID from Confluence URL patterns like /wiki/spaces/.../pages/123456
            const match = /\/pages\/(\d+)/.exec(url);
            return match?.[1] ?? '';
          })
          .filter(Boolean);
      } catch {
        // Remote links are optional — ignore errors
      }

      return {
        assignee: issue.fields?.assignee?.displayName ?? undefined,
        components: (issue.fields?.components ?? []).map((c) => c.name ?? '').filter(Boolean),
        description: adfToPlainText(issue.fields?.description).trim(),
        id: issue.key ?? id,
        labels: issue.fields?.labels ?? [],
        linkedPageIds: linkedPageIds.length > 0 ? linkedPageIds : undefined,
        priority: issue.fields?.priority?.name ?? undefined,
        raw: issue,
        status: issue.fields?.status?.name ?? 'unknown',
        title: issue.fields?.summary ?? id,
        url: `${(this.client as unknown as { config: { baseUrl: string } }).config?.baseUrl?.replace(/\/+$/, '') ?? ''}/browse/${encodeURIComponent(issue.key ?? id)}`,
      };
    } catch (err) {
      if (err instanceof AtlassianError && err.code === 'not_found') {
        return null;
      }
      this.log?.warn({ err, issueId: id }, 'Jira fetchIssue failed');
      return null;
    }
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

      // Build browse URL — we need the base URL; access via the client config
      const baseUrl =
        (this.client as unknown as { config: { baseUrl: string } }).config?.baseUrl?.replace(
          /\/+$/,
          ''
        ) ?? '';

      return {
        id: created.id,
        title: fields.title,
        type: fields.issueType === this.epicIssueType ? 'epic' : 'story',
        url: `${baseUrl}/browse/${created.key}`,
      };
    } catch (err) {
      this.log?.warn({ err, fields }, 'Jira createIssue failed');
      return null;
    }
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

  async addComment(issueId: string, bodyText: string): Promise<void> {
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
        body: adfFromText(bodyText),
      });
    } catch (err) {
      this.log?.warn({ err, issueId }, 'Jira addComment failed');
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
