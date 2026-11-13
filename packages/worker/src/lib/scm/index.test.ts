import { ApplicationFailure } from '@temporalio/activity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubScmProvider } from './github.js';
import {
  getScmProvider,
  registerScmProviderForTest,
  SCM_PROVIDER_UNSUPPORTED,
  toRepoRef,
} from './index.js';

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

  it('does not treat a ref with no provider as github', () => {
    // Types forbid it; a value that slips through (a stale cast) must not mean GitHub.
    expect(() => getScmProvider({} as never)).toThrow(/is not supported/);
  });

  it('returns the same instance for every call', () => {
    expect(getScmProvider({ scmProvider: 'github' })).toBe(
      getScmProvider({ scmProvider: 'github' })
    );
  });

  describe('the registry test seam', () => {
    const second = { name: 'second' } as never;

    it('dispatches a registered name, then forgets it', () => {
      const unregister = registerScmProviderForTest('gitlab', second);
      expect(getScmProvider({ scmProvider: 'gitlab' })).toBe(second);
      unregister();
      expect(() => getScmProvider({ scmProvider: 'gitlab' })).toThrow(/"gitlab" is not supported/);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('refuses to register unless NODE_ENV is test and VITEST is set', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => registerScmProviderForTest('gitlab', second)).toThrow(/for tests only/);
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('VITEST', '');
      expect(() => registerScmProviderForTest('gitlab', second)).toThrow(/for tests only/);
      expect(() => getScmProvider({ scmProvider: 'gitlab' })).toThrow(/"gitlab" is not supported/);
    });

    it('leaves the real github entry in place for every other name a test registers', () => {
      const unregister = registerScmProviderForTest('gitlab', second);
      expect(getScmProvider({ scmProvider: 'github' })).toBeInstanceOf(GitHubScmProvider);
      unregister();
      expect(getScmProvider({ scmProvider: 'github' })).toBeInstanceOf(GitHubScmProvider);
    });

    it('cannot replace the real github entry or register one name twice', () => {
      expect(() => registerScmProviderForTest('github', second)).toThrow(/already registered/);
      const unregister = registerScmProviderForTest('bitbucket', second);
      expect(() => registerScmProviderForTest('bitbucket', second)).toThrow(/already registered/);
      unregister();
    });
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
