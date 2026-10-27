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
