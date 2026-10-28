import { describe, expect, it, vi } from 'vitest';
import { GitHubIssuesProvider, parseGitHubTicketId } from './githubIssues.js';

describe('parseGitHubTicketId', () => {
  const defaultRepo = { owner: 'acme', repo: 'api' };

  it('parses owner/repo#n, and bare / hash-prefixed numbers against the default repo', () => {
    expect(parseGitHubTicketId('acme/web#12')).toEqual({ number: 12, owner: 'acme', repo: 'web' });
    expect(parseGitHubTicketId('#7', defaultRepo)).toEqual({
      number: 7,
      owner: 'acme',
      repo: 'api',
    });
    expect(parseGitHubTicketId('7', defaultRepo)).toEqual({
      number: 7,
      owner: 'acme',
      repo: 'api',
    });
    expect(parseGitHubTicketId('7')).toBeNull();
  });

  it('rejects dot segments that would rewrite the API path once interpolated', () => {
    expect(parseGitHubTicketId('../web#1')).toBeNull();
    expect(parseGitHubTicketId('acme/..#1')).toBeNull();
    expect(parseGitHubTicketId('./api#1')).toBeNull();
    // Dots inside a name are legal on GitHub and stay accepted.
    expect(parseGitHubTicketId('acme/my.repo#1')).toEqual({
      number: 1,
      owner: 'acme',
      repo: 'my.repo',
    });
  });
});

describe('GitHubIssuesProvider.addComment', () => {
  const make = (status: number) => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response('{}', { status }));
    return {
      fetchImpl,
      provider: new GitHubIssuesProvider({ apiToken: 't', fetchImpl: fetchImpl as typeof fetch }),
    };
  };

  it('posts to the issue comments endpoint and reports it posted', async () => {
    const { fetchImpl, provider } = make(201);
    await expect(provider.addComment('acme/api#7', 'hi')).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/acme/api/issues/7/comments'
    );
  });

  it('reports a rejected post as not posted', async () => {
    await expect(make(403).provider.addComment('acme/api#7', 'hi')).resolves.toBe(false);
  });

  it('reports an id it cannot place as not posted, without a request', async () => {
    const { fetchImpl, provider } = make(201);
    await expect(provider.addComment('7', 'hi')).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs a warning naming the id it cannot place, and nothing of the comment', async () => {
    const warn = vi.fn();
    const provider = new GitHubIssuesProvider({ apiToken: 't', log: { warn } });
    await provider.addComment('not-an-issue', 'secret comment text');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { issueId: 'not-an-issue' },
      'GitHub addComment: ticket ID must be owner/repo#123 or a bare issue number'
    );
  });
});

describe('GitHubIssuesProvider redirects stay in the targeted repository', () => {
  const redirect = (status: number, location: string) =>
    new Response(null, { headers: { location }, status });
  const issueJson = (extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ body: 'b', number: 42, state: 'open', title: 't', ...extra }), {
      status: 200,
    });
  const make = (...responses: Response[]) => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => responses.shift() as Response);
    return {
      fetchImpl,
      provider: new GitHubIssuesProvider({ apiToken: 't', fetchImpl: fetchImpl as typeof fetch }),
    };
  };

  it('does not follow a read to a transferred issue', async () => {
    const { fetchImpl, provider } = make(redirect(301, '/repositories/9/issues/1'));
    await expect(provider.fetchIssue('acme/api#42')).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not follow a comment POST or a transition PATCH to another repository', async () => {
    const post = make(redirect(307, '/repositories/9/issues/1/comments'));
    await expect(post.provider.addComment('acme/api#42', 'hi')).resolves.toBe(false);
    expect(post.fetchImpl).toHaveBeenCalledTimes(1);
    const patch = make(redirect(308, '/repositories/9/issues/1'));
    await patch.provider.transitionIssue('acme/api#42', 'done');
    expect(patch.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not follow a createIssue POST to another repository', async () => {
    const { fetchImpl, provider } = make(redirect(308, '/repositories/9/issues'));
    await expect(
      provider.createIssue({
        description: 'd',
        issueType: 'Task',
        projectKey: 'acme/api',
        title: 't',
      })
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still follows a redirect to the same repository path, ignoring case', async () => {
    const { fetchImpl, provider } = make(redirect(301, '/repos/ACME/Api/issues/42'), issueJson());
    await expect(provider.fetchIssue('acme/api#42')).resolves.toMatchObject({ title: 't' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a redirect that climbs out of the repository with encoded dots', async () => {
    const { fetchImpl, provider } = make(redirect(301, '/repos/acme/api/%2e%2e/%2e%2e/x'));
    await expect(provider.fetchIssue('acme/api#42')).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null when the issue reports a different repository_url', async () => {
    const { provider } = make(issueJson({ repository_url: 'https://api.github.com/repos/o/r' }));
    await expect(provider.fetchIssue('acme/api#42')).resolves.toBeNull();
  });

  it('accepts a repository_url naming the same repository, ignoring case', async () => {
    const { provider } = make(
      issueJson({ repository_url: 'https://api.github.com/repos/Acme/API' })
    );
    await expect(provider.fetchIssue('acme/api#42')).resolves.toMatchObject({ title: 't' });
  });
});

describe('GitHubIssuesProvider.searchIssues', () => {
  it('is not supported: polling a filter is Jira only', async () => {
    const provider = new GitHubIssuesProvider({ apiToken: 't' });
    await expect(provider.searchIssues('x', { maxResults: 5 })).rejects.toThrow(
      'searchIssues is not supported by the GitHub Issues provider'
    );
  });
});
