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
 * Map a Prisma `Repository` row to the provider-agnostic `RepoRef`. The DB
 * columns keep their GitHub-era names (`githubUrl`, `githubApiUrl`); they act
 * as per-repo host overrides for whichever provider serves the repo.
 */
export function toRepoRef(repo: {
  organizationName: string;
  repoName: string;
  githubUrl?: string | null;
  githubApiUrl?: string | null;
}): RepoRef {
  return {
    apiUrl: repo.githubApiUrl ?? null,
    baseUrl: repo.githubUrl ?? null,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  };
}
