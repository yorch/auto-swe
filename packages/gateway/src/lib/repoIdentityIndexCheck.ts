import type { PrismaClient } from '@auto-swe/shared';
import { resolvePlatformCredential } from '@auto-swe/shared/lib/githubHostCredential';
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
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
 * repositories sit on a host with no platform credential: another host than
 * the instance's that has none of its own (`mismatch`), or web and API
 * overrides on different hosts (`misconfigured`). Their runs fail
 * non-retryably with `REPO_CREDENTIAL_HOST_MISMATCH` /
 * `REPO_HOST_MISCONFIGURED`, and the launch gate refuses with `host-mismatch`.
 * The remedy is a PAT or App for that host (Host credentials), the instance's
 * web and API URLs (when the instance's credential belongs to that host), both
 * overrides on one host, or a user's own saved token. Returns whether it
 * warned; never throws.
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
          installation: { select: { host: true, installationId: true } },
          organizationName: true,
          repoName: true,
        },
        where: { isActive: true, type: 'git_repo' },
      })
    );
    const ghConfig = await resolveGitHubConfig();
    const unusable: Array<{ error: string; host: string; id: string; repository: string }> = [];
    for (const r of repos) {
      const { scope } = await resolvePlatformCredential(
        {
          apiUrl: r.githubApiUrl,
          baseUrl: r.githubUrl,
          installationHost: r.installation?.host ?? null,
          installationId: r.installation?.installationId ?? null,
        },
        ghConfig
      );
      if (scope !== 'instance' && scope !== 'host') {
        unusable.push({
          error:
            scope === 'misconfigured'
              ? 'REPO_HOST_MISCONFIGURED'
              : scope === 'installation-mismatch'
                ? 'REPO_INSTALLATION_HOST_MISMATCH'
                : 'REPO_CREDENTIAL_HOST_MISMATCH',
          host: hostFamily(r.githubUrl ?? r.githubApiUrl ?? ghConfig.baseUrl),
          id: r.id,
          repository: `${r.organizationName}/${r.repoName}`,
        });
      }
    }
    if (unusable.length === 0) {
      return false;
    }
    log.warn(
      {
        instanceHost: hostFamily(ghConfig.baseUrl),
        repositories: unusable.slice(0, MAX_UNUSABLE_LISTED),
        total: unusable.length,
      },
      `${unusable.length} active repositor${unusable.length === 1 ? 'y is' : 'ies are'} on a host with no platform GitHub credential (the instance's host is ${hostFamily(ghConfig.baseUrl)}); a platform credential is never sent to a host it does not belong to, so their runs fail with the error named per repository. Remedy: add a PAT or GitHub App for that host (Studio -> Integrations -> GitHub -> Host credentials); or, if the instance's credential belongs to that host, set the GitHub integration's web and API URLs to it; for a half override, set both URL overrides to one host; otherwise a user must save their own token for the repository.`
    );
    return true;
  } catch (err) {
    log.warn({ err }, 'could not check repository hosts against the instance host');
    return false;
  }
}
