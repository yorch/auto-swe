import { GitHubScmProvider } from './github.js';
import {
  type RepoRef,
  SCM_PROVIDER_UNSUPPORTED,
  type ScmProvider,
  scmProviderUnsupported,
} from './types.js';

export type {
  CloneCredentials,
  CreatePullRequestInput,
  PullRequestRef,
  RepoRef,
  ScmProvider,
} from './types.js';
export { SCM_PROVIDER_UNSUPPORTED, scmProviderUnsupported };

/**
 * The registry: provider name (the `Connection.scmProvider` value) to implementation. A provider
 * exists only if it has an entry here, and an entry is added only with a class that implements the
 * whole `ScmProvider` interface — there is deliberately no stub for a host that is not implemented.
 */
const PROVIDERS: Record<string, ScmProvider> = {
  github: new GitHubScmProvider(),
};

/**
 * Test seam: register `provider` under `name` until the returned function is called. It exists so
 * a test can stand a second provider in the registry and prove that GitHub-only paths still refuse
 * a repository served by it. It refuses to run outside a test process, and it cannot replace a
 * real entry.
 */
export function registerScmProviderForTest(name: string, provider: ScmProvider): () => void {
  if (!process.env.VITEST) {
    throw new Error('registerScmProviderForTest is for tests only');
  }
  if (Object.hasOwn(PROVIDERS, name)) {
    throw new Error(`The SCM provider "${name}" is already registered`);
  }
  PROVIDERS[name] = provider;
  return () => {
    delete PROVIDERS[name];
  };
}

/**
 * Resolve the `ScmProvider` for a repository by its `scmProvider` name.
 *
 * A name with no registry entry throws a non-retryable `SCM_PROVIDER_UNSUPPORTED` failure naming
 * it. It never falls back to GitHub: the GitHub client would send a repository on another host the
 * GitHub credential, and a platform credential must never leave its host (CLAUDE.md §6). The name
 * is required (`RepoRef.scmProvider`), so a ref cannot silently mean GitHub; `toRepoRef` always
 * carries the stored value.
 */
export function getScmProvider(repo: Pick<RepoRef, 'scmProvider'>): ScmProvider {
  const name = repo.scmProvider;
  const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
  if (!provider) {
    throw scmProviderUnsupported(name, `Supported: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  return provider;
}

/**
 * Map a `git_repo` Connection row to the provider-agnostic `RepoRef`. The DB
 * columns keep their GitHub-era names (`githubUrl`, `githubApiUrl`); they act
 * as per-repo host overrides for whichever provider serves the repo.
 *
 * `organizationName`/`repoName` are nullable on `Connection` (non-git
 * connection types like `mcp` omit them) — this throws if called on a row that
 * lacks git identity, since the SCM paths only run for `git_repo` connections.
 *
 * `scmProvider` is required too, for the same reason: a projection that omits it would resolve
 * every repository to GitHub, so the omission must fail to compile.
 *
 * `installation` is a **required** property even though its value may be null,
 * so a caller that forgets to include `installation` fails to compile
 * rather than silently resolving the default installation. A repository reached
 * through the wrong installation does not fail loudly: its clone 404s as if the
 * repo did not exist, and a permission lookup answers "no access" for a user who
 * has it. Null is the deliberate "use the instance-wide default" value.
 */
export function toRepoRef(repo: {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  githubUrl: string | null;
  githubApiUrl: string | null;
  scmProvider: string;
  installation: { installationId: string; host: string } | null;
}): RepoRef {
  if (!repo.organizationName || !repo.repoName) {
    throw new Error('toRepoRef requires a git_repo connection (organizationName/repoName)');
  }
  return {
    apiUrl: repo.githubApiUrl,
    baseUrl: repo.githubUrl,
    connectionId: repo.id,
    installationHost: repo.installation?.host ?? null,
    installationId: repo.installation?.installationId ?? null,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
    scmProvider: repo.scmProvider,
  };
}
