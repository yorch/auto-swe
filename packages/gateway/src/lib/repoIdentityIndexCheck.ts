import type { PrismaClient } from '@auto-swe/shared';
import { hostFamily, platformCredentialScope } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isGitHubDotComHost } from './repositoryHost.js';

interface Logger {
  warn(obj: object, msg: string): void;
}

/**
 * Warns when a webhook-secret row exists for a host that sends no
 * `X-GitHub-Enterprise-Host` header: github.com, GitHub Enterprise Cloud with
 * data residency (`<tenant>.ghe.com`), or the API host of either. Such a row is
 * never selected; the admin API refuses to create one, so this is legacy data.
 * It is ignored when scoping deliveries, but the operator should delete it.
 * Returns whether it warned; never throws.
 */
export async function warnIfGitHubDotComWebhookSecret(
  prisma: PrismaClient,
  log: Logger
): Promise<boolean> {
  try {
    const rows = await prisma.gitHubHostWebhookSecret.findMany({ select: { host: true } });
    const hosts = rows.map((r) => r.host).filter(isGitHubDotComHost);
    if (hosts.length === 0) {
      return false;
    }
    log.warn(
      { hosts },
      'a GitHub webhook secret is stored for github.com or a *.ghe.com host; those hosts send no X-GitHub-Enterprise-Host header and always sign with the instance secret, so the row is never used. Delete it.'
    );
    return true;
  } catch (err) {
    log.warn({ err }, 'could not check for a github.com webhook secret row');
    return false;
  }
}

const MAX_UNUSABLE_LISTED = 20;

/**
 * Warns, listing them (the first 20, plus the count), when active git
 * repositories sit on a host the platform credential may not go to: another
 * host than the instance's (`mismatch`), or web and API overrides on different
 * hosts (`misconfigured`). Their runs fail non-retryably with
 * `REPO_CREDENTIAL_HOST_MISMATCH` / `REPO_HOST_MISCONFIGURED`, and the launch
 * gate refuses with `host-mismatch`. The remedy is the instance's web and API
 * URLs (when the platform's credential belongs to that host), both overrides
 * on one host, or a user's own saved token. Returns whether it warned; never
 * throws.
 */
export async function warnIfReposOnUnusableHosts(
  prisma: PrismaClient,
  log: Logger
): Promise<boolean> {
  try {
    const repos = await runUnscoped('a startup check spans every team', ['Connection'], () =>
      prisma.connection.findMany({
        select: {
          githubApiUrl: true,
          githubUrl: true,
          id: true,
          installation: { select: { installationId: true } },
          organizationName: true,
          repoName: true,
        },
        where: { isActive: true, type: 'git_repo' },
      })
    );
    const ghConfig = await resolveGitHubConfig();
    const unusable = repos.flatMap((r) => {
      const scope = platformCredentialScope(
        {
          apiUrl: r.githubApiUrl,
          baseUrl: r.githubUrl,
          installationId: r.installation?.installationId ?? null,
        },
        ghConfig
      );
      return scope === 'instance'
        ? []
        : [
            {
              error:
                scope === 'misconfigured'
                  ? 'REPO_HOST_MISCONFIGURED'
                  : 'REPO_CREDENTIAL_HOST_MISMATCH',
              host: hostFamily(r.githubUrl ?? r.githubApiUrl ?? ghConfig.baseUrl),
              id: r.id,
              repository: `${r.organizationName}/${r.repoName}`,
            },
          ];
    });
    if (unusable.length === 0) {
      return false;
    }
    log.warn(
      {
        instanceHost: hostFamily(ghConfig.baseUrl),
        repositories: unusable.slice(0, MAX_UNUSABLE_LISTED),
        total: unusable.length,
      },
      `${unusable.length} active repositor${unusable.length === 1 ? 'y is' : 'ies are'} on a host the platform's GitHub credential is not valid on (the instance's host is ${hostFamily(ghConfig.baseUrl)}); the platform credential is never sent elsewhere, so their runs fail with the error named per repository. Remedy: if the platform's credential belongs to that host, set the GitHub integration's web and API URLs to it (Studio -> Integrations -> GitHub); for a half override, set both URL overrides to one host; otherwise a user must save their own token for the repository.`
    );
    return true;
  } catch (err) {
    log.warn({ err }, 'could not check repository hosts against the instance host');
    return false;
  }
}
