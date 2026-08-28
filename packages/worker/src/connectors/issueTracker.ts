import type { IssueTrackerConnectionConfig } from '@auto-swe/shared';
import { ApplicationFailure } from '@temporalio/activity';

const ISSUE_TRACKER_TIMEOUT_MS = 30_000;

export interface IssueTrackerConnectionLike {
  apiToken: string;
  config: IssueTrackerConnectionConfig;
}

export interface CreateIssueInput {
  description?: string;
  projectKey?: string;
  title: string;
}

export interface IssueResult {
  description?: string;
  id: string;
  identifier?: string;
  title?: string;
  url: string;
}

function requireProvider(config: IssueTrackerConnectionConfig): 'linear' | 'jira' {
  if (!config.provider) {
    throw ApplicationFailure.nonRetryable(
      'issue_tracker connection is missing provider (linear or jira)'
    );
  }
  return config.provider;
}

function requireBaseUrl(config: IssueTrackerConnectionConfig): string {
  if (!config.baseUrl) {
    throw ApplicationFailure.nonRetryable('jira connection is missing baseUrl');
  }
  return config.baseUrl.replace(/\/+$/, '');
}

function requireEmail(config: IssueTrackerConnectionConfig): string {
  if (!config.email) {
    throw ApplicationFailure.nonRetryable('jira connection is missing email');
  }
  return config.email;
}

async function linearFetch<T>(
  connection: IssueTrackerConnectionLike,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    body: JSON.stringify({ query, variables }),
    headers: {
      Authorization: connection.apiToken,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(ISSUE_TRACKER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    if (response.status === 401 || response.status === 403) {
      throw ApplicationFailure.nonRetryable(
        `Linear API authentication failed (${response.status})`
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw ApplicationFailure.create({
        message: `Linear API transient error (${response.status}): ${body}`,
        type: 'LinearTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Linear API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { errors?: { message: string }[]; data?: T };
  if (data.errors?.length) {
    throw ApplicationFailure.nonRetryable(
      `Linear API error: ${data.errors[0]?.message ?? 'unknown'}`
    );
  }
  return data.data as T;
}

async function jiraFetch<T>(
  connection: IssueTrackerConnectionLike,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const baseUrl = requireBaseUrl(connection.config);
  const email = requireEmail(connection.config);
  const url = `${baseUrl}${path}`;
  const timeoutSignal = AbortSignal.timeout(ISSUE_TRACKER_TIMEOUT_MS);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${connection.apiToken}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    if (response.status === 401 || response.status === 403) {
      throw ApplicationFailure.nonRetryable(`Jira API authentication failed (${response.status})`);
    }
    if (response.status === 404) {
      throw ApplicationFailure.nonRetryable(`Jira issue not found (${response.status})`);
    }
    if (response.status >= 500 || response.status === 429) {
      throw ApplicationFailure.create({
        message: `Jira API transient error (${response.status}): ${body}`,
        type: 'JiraTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`Jira API error (${response.status}): ${body}`);
  }

  return response.json() as Promise<T>;
}

function jiraAdfDescription(
  text?: string
): { content: unknown[]; type: 'doc'; version: number } | undefined {
  if (!text) {
    return undefined;
  }
  return {
    content: [{ content: [{ text, type: 'text' }], type: 'paragraph' }],
    type: 'doc',
    version: 1,
  };
}

export async function createLinearIssue(
  connection: IssueTrackerConnectionLike,
  input: CreateIssueInput
): Promise<IssueResult> {
  const teamId = input.projectKey ?? connection.config.defaultProjectKey;
  if (!teamId) {
    throw ApplicationFailure.nonRetryable(
      'Linear createIssue requires a projectKey (teamId) or defaultProjectKey'
    );
  }
  const query = `
    mutation CreateIssue($title: String!, $description: String, $teamId: String!) {
      issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
        success
        issue {
          id
          identifier
          url
          title
          description
        }
      }
    }
  `;
  const data = await linearFetch<{ issueCreate: { issue?: IssueResult; success: boolean } }>(
    connection,
    query,
    {
      description: input.description ?? null,
      teamId,
      title: input.title,
    }
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw ApplicationFailure.nonRetryable('Linear failed to create issue');
  }
  return data.issueCreate.issue;
}

export async function createJiraIssue(
  connection: IssueTrackerConnectionLike,
  input: CreateIssueInput
): Promise<IssueResult> {
  const projectKey = input.projectKey ?? connection.config.defaultProjectKey;
  if (!projectKey) {
    throw ApplicationFailure.nonRetryable(
      'Jira createIssue requires a projectKey or defaultProjectKey'
    );
  }
  const payload = {
    fields: {
      description: jiraAdfDescription(input.description),
      issuetype: { name: 'Task' },
      project: { key: projectKey },
      summary: input.title,
    },
  };
  const data = await jiraFetch<{ id: string; key: string; self: string }>(
    connection,
    '/rest/api/3/issue',
    {
      body: JSON.stringify(payload),
      method: 'POST',
    }
  );
  return {
    id: data.id,
    identifier: data.key,
    url: `${requireBaseUrl(connection.config)}/browse/${data.key}`,
  };
}

export async function fetchLinearIssue(
  connection: IssueTrackerConnectionLike,
  issueId: string
): Promise<IssueResult> {
  const query = `
    query Issue($id: String!) {
      issue(id: $id) {
        id
        identifier
        url
        title
        description
      }
    }
  `;
  const data = await linearFetch<{ issue: IssueResult | null }>(connection, query, { id: issueId });
  if (!data.issue) {
    throw ApplicationFailure.nonRetryable(`Linear issue ${issueId} not found`);
  }
  return data.issue;
}

export async function fetchJiraIssue(
  connection: IssueTrackerConnectionLike,
  issueId: string
): Promise<IssueResult> {
  const data = await jiraFetch<{
    fields: { description?: string; summary: string };
    id: string;
    key: string;
    self: string;
  }>(connection, `/rest/api/3/issue/${issueId}`);
  return {
    description: typeof data.fields.description === 'string' ? data.fields.description : undefined,
    id: data.id,
    identifier: data.key,
    title: data.fields.summary,
    url: `${requireBaseUrl(connection.config)}/browse/${data.key}`,
  };
}

export async function createIssue(
  connection: IssueTrackerConnectionLike,
  input: CreateIssueInput
): Promise<IssueResult> {
  const provider = requireProvider(connection.config);
  if (provider === 'linear') {
    return createLinearIssue(connection, input);
  }
  return createJiraIssue(connection, input);
}

export async function fetchIssue(
  connection: IssueTrackerConnectionLike,
  issueId: string
): Promise<IssueResult> {
  const provider = requireProvider(connection.config);
  if (provider === 'linear') {
    return fetchLinearIssue(connection, issueId);
  }
  return fetchJiraIssue(connection, issueId);
}
