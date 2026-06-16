import { GitHubScmProvider } from './github.js';
import type { RepoRef, ScmProvider } from './types.js';

export type {
  CloneCredentials,
  CreatePullRequestInput,
  PullRequestRef,
  RepoRef,
  ScmProvider,
} from './types.js';

const githubProvider = new GitHubScmProvider();

/**
 * Resolve the `ScmProvider` for a repository.
 *
 * GitHub is the only implementation today, so this always returns it. When a
 * second provider (e.g. GitLab) lands, selection will key off configuration —
 * e.g. a `Repository.scmProvider` column or an SCM section in system config.
 * That column is intentionally NOT added yet; the optional `repo` parameter
 * exists so call sites already pass the information selection will need.
 */
export function getScmProvider(_repo?: RepoRef): ScmProvider {
  return githubProvider;
}

/**
 * Map a `git_repo` Connection row to the provider-agnostic `RepoRef`. The DB
 * columns keep their GitHub-era names (`githubUrl`, `githubApiUrl`); they act
 * as per-repo host overrides for whichever provider serves the repo.
 *
 * `organizationName`/`repoName` are nullable on `Connection` (P2/WS3: non-git
 * connection types like `mcp` omit them) — this throws if called on a row that
 * lacks git identity, since the SCM paths only run for `git_repo` connections.
 */
export function toRepoRef(repo: {
  organizationName: string | null;
  repoName: string | null;
  githubUrl?: string | null;
  githubApiUrl?: string | null;
}): RepoRef {
  if (!repo.organizationName || !repo.repoName) {
    throw new Error('toRepoRef requires a git_repo connection (organizationName/repoName)');
  }
  return {
    apiUrl: repo.githubApiUrl ?? null,
    baseUrl: repo.githubUrl ?? null,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  };
}
