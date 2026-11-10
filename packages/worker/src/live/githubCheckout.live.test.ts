import { describe, expect, it } from 'vitest';
import { cloneDependencyRepos, createWorkspace } from '../activities/workspace.js';
import { getScmProvider } from '../lib/scm/index.js';
import type { RepoRef } from '../lib/scm/types.js';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * A credentialed checkout of a GitHub repository into a real Docker workspace, both as the
 * workspace's own repository and as read-only reference material cloned beside it
 * (`cloneDependencyRepos`). The clone credential is resolved by the SCM provider exactly as a run
 * resolves it, sent for the clone alone, and must not be left behind: neither repository's
 * `.git/config` may contain the token afterwards.
 *
 * Needs a Docker daemon the worker's backend can reach (`DOCKER_HOST` as in `ci.yml`) and
 * `DATABASE_URL` pointing at the migrated stack database, as for the review suite. The workspace
 * uses the deployment's default image. Opt in with `LIVE_GITHUB_CHECKOUT=1`.
 */
const REQUIRED = ['GITHUB_TOKEN', 'LIVE_E2E_FIXTURE_REPO', 'LIVE_E2E_DATABASE_URL'] as const;
const gate = liveGate(
  'github checkout',
  'LIVE_GITHUB_CHECKOUT',
  process.env.LIVE_GITHUB_CHECKOUT === '1',
  REQUIRED
);

describe.skipIf(!gate.enabled)(liveTitle('live GitHub checkout into a workspace', gate), () => {
  it('clones the repository and a read-only dependency without leaving the token behind', async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must be the stack database named by LIVE_E2E_DATABASE_URL'
    ).toBe(liveEnv('LIVE_E2E_DATABASE_URL'));
    const [organizationName, repoName] = liveEnv('LIVE_E2E_FIXTURE_REPO').split('/') as [
      string,
      string,
    ];
    const repo: RepoRef = { installationHost: null, organizationName, repoName };
    const provider = getScmProvider(repo);
    const credentials = await provider.cloneCredentials(repo);
    expect(credentials.token).toBeTruthy();

    const workspace = await createWorkspace(credentials.authedCloneUrl, 'live-checkout', 'main');
    try {
      const listing = await workspace.exec('ls /workspace/target-repo');
      expect(listing).toContain('package.json');

      const cloned = await cloneDependencyRepos(workspace, [
        { authedCloneUrl: credentials.authedCloneUrl, name: 'fixture-dependency' },
      ]);
      expect(cloned).toEqual([
        { label: 'fixture-dependency', path: '/workspace/deps/fixture-dependency' },
      ]);
      expect(await workspace.exec('ls /workspace/deps/fixture-dependency')).toContain(
        'package.json'
      );

      for (const dir of ['/workspace/target-repo', '/workspace/deps/fixture-dependency']) {
        const config = await workspace.exec(`cat ${dir}/.git/config`);
        expect(config, `${dir}/.git/config`).not.toContain(credentials.token);
        const origin = await workspace.exec(`git -C ${dir} remote get-url origin`);
        expect(origin).not.toContain(credentials.token);
      }
    } finally {
      await workspace.destroy();
    }
  }, 600_000);
});
