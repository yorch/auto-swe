import { describe, expect, it, vi } from 'vitest';

const { adminTracker } = vi.hoisted(() => ({
  adminTracker: { allowPrivateNetwork: false, baseUrl: null as string | null },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => adminTracker),
}));

import { createIssue, fetchIssue } from './issueTracker.js';

describe('createIssue', () => {
  it('creates a Linear issue', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          issueCreate: {
            issue: {
              description: 'A bug',
              id: 'issue-1',
              identifier: 'TEAM-1',
              title: 'Bug',
              url: 'https://linear.app/issue/TEAM-1',
            },
            success: true,
          },
        },
      }),
      ok: true,
    });

    const result = await createIssue(
      { apiToken: 'lin_api_test', config: { defaultProjectKey: 'team-uuid', provider: 'linear' } },
      { description: 'A bug', projectKey: 'team-uuid', title: 'Bug' }
    );

    expect(result.identifier).toBe('TEAM-1');
    expect(result.url).toBe('https://linear.app/issue/TEAM-1');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        body: expect.stringContaining('CreateIssue'),
        headers: expect.objectContaining({ Authorization: 'lin_api_test' }),
        method: 'POST',
      })
    );
  });

  it('creates a Jira issue', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        id: '10001',
        key: 'PROJ-42',
        self: 'https://x.atlassian.net/rest/api/3/issue/10001',
      }),
      ok: true,
    });

    const result = await createIssue(
      {
        apiToken: 'jira_token',
        config: {
          baseUrl: 'https://x.atlassian.net',
          email: 'a@b.com',
          provider: 'jira',
        },
      },
      { description: 'A task', projectKey: 'PROJ', title: 'Task' }
    );

    expect(result.identifier).toBe('PROJ-42');
    expect(result.url).toBe('https://x.atlassian.net/browse/PROJ-42');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://x.atlassian.net/rest/api/3/issue',
      expect.objectContaining({
        body: expect.stringContaining('PROJ'),
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Basic '),
        }),
        method: 'POST',
      })
    );
  });

  it('throws for a missing provider', async () => {
    await expect(createIssue({ apiToken: 'x', config: {} }, { title: 'Bug' })).rejects.toThrow(
      /missing provider/
    );
  });
});

describe('fetchIssue', () => {
  it('fetches a Linear issue', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          issue: {
            id: 'issue-1',
            identifier: 'TEAM-1',
            title: 'Bug',
            url: 'https://linear.app/issue/TEAM-1',
          },
        },
      }),
      ok: true,
    });

    const result = await fetchIssue(
      { apiToken: 'lin_api_test', config: { provider: 'linear' } },
      'issue-1'
    );
    expect(result.identifier).toBe('TEAM-1');
  });

  it('fetches a Jira issue', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        fields: { summary: 'Bug' },
        id: '10001',
        key: 'PROJ-42',
        self: 'https://x.atlassian.net/rest/api/3/issue/10001',
      }),
      ok: true,
    });

    const result = await fetchIssue(
      {
        apiToken: 'jira_token',
        config: { baseUrl: 'https://x.atlassian.net', email: 'a@b.com', provider: 'jira' },
      },
      'PROJ-42'
    );
    expect(result.identifier).toBe('PROJ-42');
  });
});

describe('jira baseUrl SSRF guard', () => {
  const jira = (baseUrl: string) => ({
    apiToken: 'jira_token',
    config: { baseUrl, email: 'a@b.com', provider: 'jira' as const },
  });

  it.each([
    'http://169.254.169.254',
    'http://localhost:8080',
    'http://10.0.0.5',
    'http://metadata.google.internal.',
  ])('refuses %s without sending the credential', async (baseUrl) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(fetchIssue(jira(baseUrl), 'PROJ-1')).rejects.toThrow(/SSRF guard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a private host only when an admin opted in for that exact origin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ fields: { summary: 's' }, id: '1', key: 'PROJ-1' }),
      ok: true,
    });
    adminTracker.allowPrivateNetwork = true;
    adminTracker.baseUrl = 'https://jira.corp.internal';
    try {
      await expect(fetchIssue(jira('https://jira.corp.internal'), 'PROJ-1')).resolves.toBeDefined();
      await expect(fetchIssue(jira('https://other.corp.internal'), 'PROJ-1')).rejects.toThrow(
        /SSRF guard/
      );
    } finally {
      adminTracker.allowPrivateNetwork = false;
      adminTracker.baseUrl = null;
    }
  });

  it('does not follow redirects with the credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ fields: { summary: 's' }, id: '1', key: 'PROJ-1' }),
      ok: true,
    });
    globalThis.fetch = fetchMock;
    await fetchIssue(jira('https://x.atlassian.net'), 'PROJ-1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error' })
    );
  });
});
