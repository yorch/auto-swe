import type { IssueTrackerProvider } from '../issueTracker.js';
import type {
  CreatedIssue,
  FetchedIssue,
  FetchIssueOptions,
  IssueCreateFields,
  TrackerSyncEvent,
} from '../types.js';

interface GitHubIssuesConfig {
  apiToken?: string | null;
  baseUrl?: string;
  defaultRepo?: { owner: string; repo: string };
  log?: { warn: (obj: unknown, msg?: string) => void };
}

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/// Parses `owner/repo#123`, `123`, or `#123` (the latter two resolved against
/// `defaultRepo`). Returns null when the ID doesn't look like a GitHub issue.
export function parseGitHubTicketId(
  ticketId: string,
  defaultRepo?: { owner: string; repo: string }
): { owner: string; repo: string; number: number } | null {
  const qualified = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ticketId);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    // `.`/`..` are legal for the character class but not as GitHub names, and
    // they would rewrite the request path once interpolated.
    if (isDotSegment(qualified[1]) || isDotSegment(qualified[2])) {
      return null;
    }
    return { number: Number(qualified[3]), owner: qualified[1], repo: qualified[2] };
  }
  const bare = /^#?(\d+)$/.exec(ticketId);
  if (bare?.[1] && defaultRepo) {
    return { number: Number(bare[1]), owner: defaultRepo.owner, repo: defaultRepo.repo };
  }
  return null;
}

export class GitHubIssuesProvider implements IssueTrackerProvider {
  private readonly apiToken: string | null;
  private readonly baseUrl: string;
  private readonly defaultRepo: { owner: string; repo: string } | undefined;
  private readonly log: { warn: (obj: unknown, msg?: string) => void } | undefined;

  constructor(config: GitHubIssuesConfig) {
    this.apiToken = config.apiToken ?? null;
    this.baseUrl = (config.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.defaultRepo = config.defaultRepo;
    this.log = config.log;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'auto-swe/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.apiToken) {
      h.Authorization = `Bearer ${this.apiToken}`;
    }
    return h;
  }

  async fetchIssue(id: string, opts?: FetchIssueOptions): Promise<FetchedIssue | null> {
    try {
      const parsed = parseGitHubTicketId(id, opts?.defaultRepo ?? this.defaultRepo);
      if (!parsed) {
        this.log?.warn(
          { issueId: id },
          'GitHub fetchIssue: ticket ID must be owner/repo#123 or a bare issue number'
        );
        return null;
      }
      const url = `${this.baseUrl}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
      const res = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.log?.warn({ issueId: id, status: res.status }, 'GitHub fetchIssue failed');
        return null;
      }
      const issue = (await res.json()) as {
        number: number;
        title?: string;
        body?: string | null;
        state?: string;
        labels?: ({ name?: string } | string)[];
        html_url?: string;
      };
      return {
        description: issue.body ?? '',
        id: `${parsed.owner}/${parsed.repo}#${issue.number}`,
        labels: (issue.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
          .filter(Boolean),
        raw: issue,
        status: issue.state ?? 'unknown',
        title: issue.title ?? id,
        url: issue.html_url ?? url,
      };
    } catch (err) {
      this.log?.warn({ err, issueId: id }, 'GitHub fetchIssue failed');
      return null;
    }
  }

  async createIssue(fields: IssueCreateFields): Promise<CreatedIssue | null> {
    try {
      // projectKey for GitHub is "owner/repo"
      const [owner, repo] = fields.projectKey.split('/');
      if (!owner || !repo) {
        this.log?.warn({ fields }, 'GitHub createIssue: projectKey must be owner/repo');
        return null;
      }
      const url = `${this.baseUrl}/repos/${owner}/${repo}/issues`;
      const res = await fetch(url, {
        body: JSON.stringify({
          body: fields.description,
          labels: [fields.issueType.toLowerCase()],
          title: fields.title,
        }),
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as {
        id: number;
        number: number;
        html_url: string;
        title: string;
      };
      return {
        id: String(data.number),
        title: data.title,
        type: fields.issueType.toLowerCase() === 'epic' ? 'epic' : 'story',
        url: data.html_url,
      };
    } catch (err) {
      this.log?.warn({ err, fields }, 'GitHub createIssue failed');
      return null;
    }
  }

  async transitionIssue(issueId: string, targetStatusName: string): Promise<void> {
    try {
      const parsed = parseGitHubTicketId(issueId, this.defaultRepo);
      if (!parsed) {
        return;
      }
      const state = targetStatusName.toLowerCase() === 'done' ? 'closed' : 'open';
      const url = `${this.baseUrl}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
      await fetch(url, {
        body: JSON.stringify({ state }),
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        method: 'PATCH',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.log?.warn({ err, issueId, targetStatusName }, 'GitHub transitionIssue failed');
    }
  }

  async addComment(issueId: string, bodyText: string): Promise<void> {
    try {
      const parsed = parseGitHubTicketId(issueId, this.defaultRepo);
      if (!parsed) {
        return;
      }
      const url = `${this.baseUrl}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`;
      await fetch(url, {
        body: JSON.stringify({ body: bodyText }),
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.log?.warn({ err, issueId }, 'GitHub addComment failed');
    }
  }

  async addRemoteLink(issueId: string, url: string, title: string): Promise<void> {
    // GitHub has no remote link concept — add as comment
    await this.addComment(issueId, `🔗 [${title}](${url})`);
  }

  async syncOnEvent(event: TrackerSyncEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'workflow_started':
          // No direct transition for 'In Progress' on GitHub
          break;
        case 'pr_opened':
          if (event.prUrl && event.prTitle) {
            await this.addRemoteLink(event.issueId, event.prUrl, event.prTitle);
          }
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
          await this.transitionIssue(event.issueId, 'done');
          break;
        case 'workflow_failed':
          await this.addComment(
            event.issueId,
            `⚠️ Workflow failed${event.summary ? `: ${event.summary}` : ''}`
          );
          break;
      }
    } catch (err) {
      this.log?.warn({ err, event }, 'GitHub syncOnEvent failed');
    }
  }
}
