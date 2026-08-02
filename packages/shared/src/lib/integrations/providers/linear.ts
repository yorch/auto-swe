import type { IssueTrackerProvider } from '../issueTracker.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  IssueCreateFields,
  TrackerSyncEvent,
} from '../types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

interface LinearProviderConfig {
  log?: { warn: (obj: unknown, msg?: string) => void };
}

async function linearGraphql<T>(
  apiToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    body: JSON.stringify({ query, variables }),
    headers: {
      Authorization: apiToken,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Linear GraphQL HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const LINEAR_ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    state { name }
    labels { nodes { name } }
    priority
    assignee { displayName }
  }
}`;

/**
 * An issue's team workflow states. Linear has no Jira-style "transitions"
 * endpoint: an issue moves by having its `stateId` set to any state belonging
 * to its team, so the states must be resolved per issue.
 */
const LINEAR_ISSUE_STATES_QUERY = `query IssueStates($id: String!) {
  issue(id: $id) {
    id
    state { id name }
    team { states { nodes { id name type } } }
  }
}`;

const LINEAR_ISSUE_UPDATE_STATE_MUTATION = `mutation IssueUpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}`;

/**
 * Linear names its workflow states freely per team ("In Progress", "Started",
 * "Building"…), but every state carries one of five canonical `type` values.
 * Matching on name alone therefore fails on most real workspaces, which is why
 * this used to be a no-op — so an exact name match is tried first, then the
 * caller's intent is mapped through the state type.
 */
const STATUS_NAME_TO_STATE_TYPE: Record<string, string> = {
  backlog: 'backlog',
  blocked: 'unstarted',
  canceled: 'canceled',
  cancelled: 'canceled',
  closed: 'completed',
  done: 'completed',
  'in progress': 'started',
  'in review': 'started',
  merged: 'completed',
  open: 'unstarted',
  todo: 'unstarted',
};

const LINEAR_COMMENT_MUTATION = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}`;

const LINEAR_ISSUE_CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id url title }
  }
}`;

export class LinearProvider implements IssueTrackerProvider {
  private readonly log: { warn: (obj: unknown, msg?: string) => void } | undefined;

  constructor(
    private readonly apiToken: string,
    config: LinearProviderConfig
  ) {
    this.log = config.log;
  }

  async fetchIssue(id: string, _opts?: FetchIssueOptions): Promise<FetchedIssue | null> {
    try {
      type LinearResponse = {
        data?: {
          issue?: {
            identifier?: string;
            title?: string;
            description?: string | null;
            url?: string;
            state?: { name?: string };
            labels?: { nodes?: { name: string }[] };
            priority?: number;
            assignee?: { displayName?: string } | null;
          } | null;
        };
      };
      const result = await linearGraphql<LinearResponse>(this.apiToken, LINEAR_ISSUE_QUERY, {
        id,
      });
      const issue = result.data?.issue;
      if (!issue) {
        return null;
      }
      return {
        assignee: issue.assignee?.displayName ?? undefined,
        description: issue.description ?? '',
        id: issue.identifier ?? id,
        labels: (issue.labels?.nodes ?? []).map((l) => l.name),
        priority: issue.priority !== undefined ? String(issue.priority) : undefined,
        raw: issue,
        status: issue.state?.name ?? 'unknown',
        title: issue.title ?? id,
        url: issue.url ?? '',
      };
    } catch (err) {
      this.log?.warn({ err, issueId: id }, 'Linear fetchIssue failed');
      return null;
    }
  }

  async createIssue(fields: IssueCreateFields): Promise<CreatedIssue | null> {
    try {
      type CreateResponse = {
        data?: {
          issueCreate?: { success: boolean; issue?: { id: string; url: string; title: string } };
        };
      };
      const result = await linearGraphql<CreateResponse>(
        this.apiToken,
        LINEAR_ISSUE_CREATE_MUTATION,
        {
          input: {
            description: fields.description,
            ...(fields.parentId ? { parentId: fields.parentId } : {}),
            ...(fields.storyPoints ? { estimate: fields.storyPoints } : {}),
            teamId: fields.projectKey,
            title: fields.title,
          },
        }
      );
      const issue = result.data?.issueCreate?.issue;
      if (!issue) {
        return null;
      }
      return {
        id: issue.id,
        title: issue.title,
        type: 'story',
        url: issue.url,
      };
    } catch (err) {
      this.log?.warn({ err, fields }, 'Linear createIssue failed');
      return null;
    }
  }

  async transitionIssue(issueId: string, targetStatusName: string): Promise<void> {
    try {
      type StatesResponse = {
        data?: {
          issue?: {
            state?: { id: string; name: string };
            team?: { states?: { nodes?: { id: string; name: string; type: string }[] } };
          };
        };
      };
      const result = await linearGraphql<StatesResponse>(this.apiToken, LINEAR_ISSUE_STATES_QUERY, {
        id: issueId,
      });
      const states = result.data?.issue?.team?.states?.nodes ?? [];
      if (states.length === 0) {
        return;
      }

      const wanted = targetStatusName.trim().toLowerCase();
      const byName = states.find((s) => s.name.toLowerCase() === wanted);
      const wantedType = STATUS_NAME_TO_STATE_TYPE[wanted];
      const target = byName ?? (wantedType && states.find((s) => s.type === wantedType));

      // No sensible mapping, or the issue is already there — nothing to do.
      // Silently no-op like the Jira provider rather than failing the run.
      if (!target || target.id === result.data?.issue?.state?.id) {
        return;
      }

      await linearGraphql(this.apiToken, LINEAR_ISSUE_UPDATE_STATE_MUTATION, {
        id: issueId,
        stateId: target.id,
      });
    } catch (err) {
      this.log?.warn({ err, issueId, targetStatusName }, 'Linear transitionIssue failed');
    }
  }

  async addComment(issueId: string, bodyText: string): Promise<void> {
    try {
      await linearGraphql(this.apiToken, LINEAR_COMMENT_MUTATION, {
        body: bodyText,
        issueId,
      });
    } catch (err) {
      this.log?.warn({ err, issueId }, 'Linear addComment failed');
    }
  }

  async addRemoteLink(issueId: string, url: string, _title: string): Promise<void> {
    // Linear has no remote link concept — add as comment
    await this.addComment(issueId, `🔗 ${url}`);
  }

  async syncOnEvent(event: TrackerSyncEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'workflow_started':
          await this.transitionIssue(event.issueId, 'In Progress');
          break;
        case 'pr_opened':
          if (event.prUrl) {
            await this.addRemoteLink(event.issueId, event.prUrl, event.prTitle ?? 'PR');
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
          if (event.prUrl) {
            await this.addRemoteLink(event.issueId, event.prUrl, event.prTitle ?? 'PR');
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
      this.log?.warn({ err, event }, 'Linear syncOnEvent failed');
    }
  }
}
