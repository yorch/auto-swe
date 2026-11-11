import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { GitHubScmProvider } from './github.js';
import { getScmProvider, SCM_PROVIDER_UNSUPPORTED, toRepoRef } from './index.js';

const ROW = {
  githubApiUrl: null,
  githubUrl: null,
  id: 'c1',
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
  scmProvider: 'github',
};

describe('getScmProvider', () => {
  it('dispatches github to the GitHub provider', () => {
    expect(getScmProvider({ scmProvider: 'github' })).toBeInstanceOf(GitHubScmProvider);
  });

  it('treats a hand-built ref with no provider as github', () => {
    expect(getScmProvider({})).toBeInstanceOf(GitHubScmProvider);
  });

  it('returns the same instance for every call', () => {
    expect(getScmProvider({ scmProvider: 'github' })).toBe(getScmProvider({}));
  });

  it.each(['gitlab', 'bitbucket', 'GitHub', '', 'constructor', '__proto__', 'toString'])(
    'refuses %j with a non-retryable SCM_PROVIDER_UNSUPPORTED failure, not a github fallback',
    (name) => {
      let thrown: unknown;
      try {
        getScmProvider({ scmProvider: name });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApplicationFailure);
      const failure = thrown as ApplicationFailure;
      expect(failure.type).toBe(SCM_PROVIDER_UNSUPPORTED);
      expect(failure.nonRetryable).toBe(true);
      expect(failure.message).toContain(`"${name}"`);
    }
  );
});

describe('toRepoRef', () => {
  it('carries the stored provider so getScmProvider can dispatch on it', () => {
    expect(toRepoRef(ROW).scmProvider).toBe('github');
    const ref = toRepoRef({ ...ROW, scmProvider: 'gitlab' });
    expect(ref.scmProvider).toBe('gitlab');
    expect(() => getScmProvider(ref)).toThrow(/"gitlab" is not supported/);
  });
});
