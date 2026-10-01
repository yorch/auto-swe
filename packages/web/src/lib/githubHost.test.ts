import { describe, expect, it } from 'vitest';
import { githubWebBase, hostOverridesFromRepoUrls } from './githubHost';

describe('hostOverridesFromRepoUrls', () => {
  it('sends nothing for a github.com repository', () => {
    expect(
      hostOverridesFromRepoUrls(
        'https://github.com/acme/payments',
        'https://api.github.com/repos/acme/payments'
      )
    ).toEqual({});
  });

  it('reduces a GHE repository to its host bases', () => {
    expect(
      hostOverridesFromRepoUrls(
        'https://ghe.corp.example/acme/payments',
        'https://ghe.corp.example/api/v3/repos/acme/payments'
      )
    ).toEqual({
      githubApiUrl: 'https://ghe.corp.example/api/v3',
      githubUrl: 'https://ghe.corp.example',
    });
  });

  it('keeps the path prefix of a GHE install served under a sub-path', () => {
    expect(
      hostOverridesFromRepoUrls(
        'https://corp.example/github/acme/payments',
        'https://corp.example/github/api/v3/repos/acme/payments'
      )
    ).toEqual({
      githubApiUrl: 'https://corp.example/github/api/v3',
      githubUrl: 'https://corp.example/github',
    });
  });

  it('tolerates a trailing slash on html_url', () => {
    expect(
      hostOverridesFromRepoUrls('https://corp.example/github/acme/payments/', 'not a url')
    ).toEqual({ githubUrl: 'https://corp.example/github' });
  });

  it('omits the API base when it has no /repos/ segment', () => {
    expect(hostOverridesFromRepoUrls('https://ghe.example/a/b', 'not a url')).toEqual({
      githubUrl: 'https://ghe.example',
    });
  });

  it('sends nothing for an unparseable html url', () => {
    expect(hostOverridesFromRepoUrls('nope', 'nope')).toEqual({});
  });
});

describe('githubWebBase', () => {
  it('defaults to github.com', () => {
    expect(githubWebBase(null, 'acme', 'payments')).toBe('https://github.com');
  });
  it('strips a stored per-repository URL back to its host base', () => {
    expect(githubWebBase('https://github.com/acme/payments', 'acme', 'payments')).toBe(
      'https://github.com'
    );
  });
  it('keeps a host base, including a GHE path prefix', () => {
    expect(githubWebBase('https://ghe.example/', 'acme', 'payments')).toBe('https://ghe.example');
    expect(githubWebBase('https://corp.example/github', 'acme', 'payments')).toBe(
      'https://corp.example/github'
    );
  });
});
