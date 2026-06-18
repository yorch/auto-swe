/**
 * Best-effort tracker write operations for the PRD decomposition workflow.
 * Each provider wraps its HTTP call in try/catch and returns null on failure
 * so tracker outages never block the implementation queue.
 */
import type { ResolvedTrackerConfig } from './systemConfig.js';

export interface TrackerEpic {
  title: string;
  description: string;
}

export interface TrackerStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  storyPoints: number;
  repoHint?: string;
}

export interface CreatedTrackerItem {
  id: string;
  url: string | null;
  type: 'epic' | 'story';
  title: string;
}

async function createJiraIssue(
  config: ResolvedTrackerConfig,
  fields: {
    summary: string;
    description: string;
    issueType: string;
    projectKey: string;
    parentId?: string;
    storyPoints?: number;
  }
): Promise<CreatedTrackerItem | null> {
  if (!config.apiToken || !config.baseUrl || !config.email) {
    return null;
  }
  const body: Record<string, unknown> = {
    fields: {
      description: {
        content: [{ content: [{ text: fields.description, type: 'text' }], type: 'paragraph' }],
        type: 'doc',
        version: 1,
      },
      issuetype: { name: fields.issueType },
      project: { key: fields.projectKey },
      summary: fields.summary,
      ...(fields.storyPoints ? { story_points: fields.storyPoints } : {}),
      ...(fields.parentId ? { parent: { id: fields.parentId } } : {}),
    },
  };
  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/rest/api/3/issue`;
    const credentials = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    const res = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { id: string; key: string; self: string };
    return {
      id: data.id,
      title: fields.summary,
      type: fields.issueType === 'Epic' ? 'epic' : 'story',
      url: `${config.baseUrl.replace(/\/$/, '')}/browse/${data.key}`,
    };
  } catch {
    return null;
  }
}

async function createLinearIssue(
  config: ResolvedTrackerConfig,
  fields: {
    title: string;
    description: string;
    teamKey: string;
    parentId?: string;
    storyPoints?: number;
  }
): Promise<CreatedTrackerItem | null> {
  if (!config.apiToken) {
    return null;
  }
  const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id url title }
      }
    }
  `;
  const variables = {
    input: {
      description: fields.description,
      ...(fields.parentId ? { parentId: fields.parentId } : {}),
      ...(fields.storyPoints ? { estimate: fields.storyPoints } : {}),
      teamId: fields.teamKey,
      title: fields.title,
    },
  };
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      body: JSON.stringify({ query: mutation, variables }),
      headers: {
        Authorization: config.apiToken,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    if (!res.ok) {
      return null;
    }
    type LinearResponse = {
      data?: {
        issueCreate?: { success: boolean; issue?: { id: string; url: string; title: string } };
      };
    };
    const data = (await res.json()) as LinearResponse;
    const issue = data.data?.issueCreate?.issue;
    if (!issue) {
      return null;
    }
    return { id: issue.id, title: issue.title, type: 'story', url: issue.url };
  } catch {
    return null;
  }
}

async function createGitHubIssue(
  config: ResolvedTrackerConfig,
  fields: {
    title: string;
    description: string;
    owner: string;
    repo: string;
    labels?: string[];
  }
): Promise<CreatedTrackerItem | null> {
  if (!config.apiToken) {
    return null;
  }
  const base = (config.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const url = `${base}/repos/${fields.owner}/${fields.repo}/issues`;
  try {
    const res = await fetch(url, {
      body: JSON.stringify({
        body: fields.description,
        labels: fields.labels,
        title: fields.title,
      }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method: 'POST',
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
      type: 'story',
      url: data.html_url,
    };
  } catch {
    return null;
  }
}

/**
 * Create a tracker epic for the given provider. Returns null on any error.
 * The `projectKey` is the Jira project key or Linear team id; ignored for GitHub.
 */
export async function createTrackerEpic(
  config: ResolvedTrackerConfig,
  epic: TrackerEpic,
  projectKey?: string | null
): Promise<CreatedTrackerItem | null> {
  if (!config.provider) {
    return null;
  }
  if (config.provider === 'jira') {
    return createJiraIssue(config, {
      description: epic.description,
      issueType: 'Epic',
      projectKey: projectKey ?? 'BACKLOG',
      summary: epic.title,
    });
  }
  if (config.provider === 'linear') {
    return createLinearIssue(config, {
      description: epic.description,
      teamKey: projectKey ?? '',
      title: epic.title,
    });
  }
  // GitHub: epics become labelled issues
  if (config.provider === 'github') {
    const [owner, repo] = (projectKey ?? '/').split('/');
    return createGitHubIssue(config, {
      description: epic.description,
      labels: ['epic'],
      owner: owner ?? '',
      repo: repo ?? '',
      title: epic.title,
    });
  }
  return null;
}

/**
 * Create a tracker story/task under an optional parent epic. Returns null on any error.
 */
export async function createTrackerStory(
  config: ResolvedTrackerConfig,
  story: TrackerStory,
  projectKey?: string | null,
  epicId?: string | null
): Promise<CreatedTrackerItem | null> {
  if (!config.provider) {
    return null;
  }
  const body = [
    story.description,
    '',
    '**Acceptance Criteria:**',
    ...story.acceptanceCriteria.map((c) => `- ${c}`),
  ].join('\n');

  if (config.provider === 'jira') {
    return createJiraIssue(config, {
      description: body,
      issueType: 'Story',
      ...(epicId ? { parentId: epicId } : {}),
      projectKey: projectKey ?? 'BACKLOG',
      storyPoints: story.storyPoints,
      summary: story.title,
    });
  }
  if (config.provider === 'linear') {
    return createLinearIssue(config, {
      description: body,
      ...(epicId ? { parentId: epicId } : {}),
      storyPoints: story.storyPoints,
      teamKey: projectKey ?? '',
      title: story.title,
    });
  }
  if (config.provider === 'github') {
    const [owner, repo] = (projectKey ?? '/').split('/');
    return createGitHubIssue(config, {
      description: body,
      labels: ['story'],
      owner: owner ?? '',
      repo: repo ?? '',
      title: story.title,
    });
  }
  return null;
}
