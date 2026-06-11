import type { ResolvedTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adfToPlainText, fetchTicket, parseGitHubTicketId } from './ticketTracker.js';

function jsonResponse(body: unknown, status = 200) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const jiraConfig: ResolvedTrackerConfig = {
  apiToken: 'jira-token',
  baseUrl: 'https://acme.atlassian.net',
  email: 'bot@acme.com',
  provider: 'jira',
};

const linearConfig: ResolvedTrackerConfig = {
  apiToken: 'lin_api_key',
  baseUrl: null,
  email: null,
  provider: 'linear',
};

const githubConfig: ResolvedTrackerConfig = {
  apiToken: 'ghp_token',
  baseUrl: null,
  email: null,
  provider: 'github',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchTicket — jira', () => {
  it('fetches and normalizes a Jira issue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        fields: {
          description: {
            content: [
              { content: [{ text: 'Add a health endpoint.', type: 'text' }], type: 'paragraph' },
            ],
            type: 'doc',
          },
          labels: ['backend'],
          status: { name: 'In Progress' },
          summary: 'Add /health',
        },
        key: 'PROJ-123',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ticket = await fetchTicket(jiraConfig, 'PROJ-123');
    expect(ticket).toEqual({
      description: 'Add a health endpoint.',
      labels: ['backend'],
      raw: expect.objectContaining({ key: 'PROJ-123' }),
      status: 'In Progress',
      title: 'Add /health',
      url: 'https://acme.atlassian.net/browse/PROJ-123',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-123');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('bot@acme.com:jira-token').toString('base64')}`
    );
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const log = { warn: vi.fn() };
    expect(await fetchTicket(jiraConfig, 'PROJ-404', { log })).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns null when jira config is incomplete (no email)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchTicket({ ...jiraConfig, email: null }, 'PROJ-1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchTicket — linear', () => {
  it('fetches and normalizes a Linear issue via GraphQL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            description: 'Do the thing',
            identifier: 'ENG-42',
            labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] },
            state: { name: 'Todo' },
            title: 'Fix the widget',
            url: 'https://linear.app/acme/issue/ENG-42',
          },
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ticket = await fetchTicket(linearConfig, 'ENG-42');
    expect(ticket).toEqual({
      description: 'Do the thing',
      labels: ['bug', 'p1'],
      raw: expect.objectContaining({ identifier: 'ENG-42' }),
      status: 'Todo',
      title: 'Fix the widget',
      url: 'https://linear.app/acme/issue/ENG-42',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('lin_api_key');
    expect(JSON.parse(init.body as string).variables).toEqual({ id: 'ENG-42' });
  });

  it('returns null when the issue does not exist (data.issue null)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: { issue: null } })));
    expect(await fetchTicket(linearConfig, 'ENG-999')).toBeNull();
  });
});

describe('fetchTicket — github', () => {
  it('fetches an issue by owner/repo#number', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        body: 'Steps to reproduce…',
        html_url: 'https://github.com/acme/api/issues/7',
        labels: [{ name: 'bug' }, 'triage'],
        state: 'open',
        title: 'Crash on boot',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ticket = await fetchTicket(githubConfig, 'acme/api#7');
    expect(ticket).toEqual({
      description: 'Steps to reproduce…',
      labels: ['bug', 'triage'],
      raw: expect.objectContaining({ title: 'Crash on boot' }),
      status: 'open',
      title: 'Crash on boot',
      url: 'https://github.com/acme/api/issues/7',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/api/issues/7');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_token');
  });

  it('resolves bare issue numbers against defaultRepo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: 'open', title: 'Bare number' }));
    vi.stubGlobal('fetch', fetchMock);

    const ticket = await fetchTicket(githubConfig, '#12', {
      defaultRepo: { owner: 'acme', repo: 'payments' },
    });
    expect(ticket?.title).toBe('Bare number');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api.github.com/repos/acme/payments/issues/12'
    );
  });

  it('returns null for unparsable ticket IDs without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const log = { warn: vi.fn() };
    expect(await fetchTicket(githubConfig, 'JIRA-123', { log })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    expect(await fetchTicket(githubConfig, 'acme/api#999')).toBeNull();
  });
});

describe('fetchTicket — failure policy', () => {
  it('returns null (never throws) on network errors / timeouts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    );
    const log = { warn: vi.fn() };
    expect(await fetchTicket(jiraConfig, 'PROJ-1', { log })).toBeNull();
    expect(await fetchTicket(linearConfig, 'ENG-1', { log })).toBeNull();
    expect(await fetchTicket(githubConfig, 'a/b#1', { log })).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('returns null when no provider is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await fetchTicket({ apiToken: null, baseUrl: null, email: null, provider: null }, 'PROJ-1')
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseGitHubTicketId', () => {
  it('parses owner/repo#number', () => {
    expect(parseGitHubTicketId('acme/my-repo.js#42')).toEqual({
      number: 42,
      owner: 'acme',
      repo: 'my-repo.js',
    });
  });

  it('parses bare numbers only with a defaultRepo', () => {
    expect(parseGitHubTicketId('42')).toBeNull();
    expect(parseGitHubTicketId('42', { owner: 'o', repo: 'r' })).toEqual({
      number: 42,
      owner: 'o',
      repo: 'r',
    });
    expect(parseGitHubTicketId('#42', { owner: 'o', repo: 'r' })).toEqual({
      number: 42,
      owner: 'o',
      repo: 'r',
    });
  });

  it('rejects everything else', () => {
    expect(parseGitHubTicketId('JIRA-1')).toBeNull();
    expect(parseGitHubTicketId('a/b')).toBeNull();
    expect(parseGitHubTicketId('a/b#x')).toBeNull();
  });
});

describe('adfToPlainText', () => {
  it('flattens nested ADF into newline-separated text', () => {
    const adf = {
      content: [
        { content: [{ text: 'Line one.', type: 'text' }], type: 'paragraph' },
        {
          content: [
            {
              content: [{ content: [{ text: 'Bullet', type: 'text' }], type: 'paragraph' }],
              type: 'listItem',
            },
          ],
          type: 'bulletList',
        },
      ],
      type: 'doc',
      version: 1,
    };
    expect(adfToPlainText(adf).trim().split('\n').filter(Boolean)).toEqual(['Line one.', 'Bullet']);
  });

  it('handles null/garbage gracefully', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(42)).toBe('');
    expect(adfToPlainText('plain string')).toBe('plain string');
  });
});
