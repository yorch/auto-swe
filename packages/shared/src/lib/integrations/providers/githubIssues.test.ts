import { describe, expect, it } from 'vitest';
import { parseGitHubTicketId } from './githubIssues.js';

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
