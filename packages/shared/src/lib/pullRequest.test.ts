import { describe, expect, it } from 'vitest';
import {
  clampPullRequestTitle,
  PULL_REQUEST_TITLE_MAX_LENGTH,
  pullRequestUrl,
} from './pullRequest.js';

describe('pullRequestUrl', () => {
  const repo = { githubUrl: null, organizationName: 'acme', repoName: 'api' };

  it('defaults to github.com', () => {
    expect(pullRequestUrl(repo, 7)).toBe('https://github.com/acme/api/pull/7');
  });

  it("uses the repository's own host and drops a trailing slash", () => {
    expect(pullRequestUrl({ ...repo, githubUrl: 'https://ghe.corp/' }, 7)).toBe(
      'https://ghe.corp/acme/api/pull/7'
    );
  });

  it('is null for a missing number or name, or a non-http(s) or malformed base', () => {
    expect(pullRequestUrl(repo, null)).toBeNull();
    expect(pullRequestUrl({ ...repo, repoName: null }, 7)).toBeNull();
    expect(pullRequestUrl({ ...repo, githubUrl: 'javascript:alert(1)' }, 7)).toBeNull();
    expect(pullRequestUrl({ ...repo, githubUrl: 'not a url' }, 7)).toBeNull();
  });
});

describe('clampPullRequestTitle', () => {
  it('trims, caps and nulls an empty title', () => {
    expect(clampPullRequestTitle('  fix it  ')).toBe('fix it');
    expect(clampPullRequestTitle('x'.repeat(1000))).toHaveLength(PULL_REQUEST_TITLE_MAX_LENGTH);
    expect(clampPullRequestTitle('   ')).toBeNull();
  });

  it('never splits a surrogate pair at the cap', () => {
    const clamped = clampPullRequestTitle(`${'x'.repeat(PULL_REQUEST_TITLE_MAX_LENGTH - 1)}😀😀`);
    expect(clamped).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
    expect(Array.from(clamped ?? '')).toHaveLength(PULL_REQUEST_TITLE_MAX_LENGTH);
    expect(clampPullRequestTitle(undefined)).toBeNull();
  });
});
