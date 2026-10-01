/**
 * Startup check that the case-insensitive repository identity index exists.
 *
 * The migration that creates `connections_git_repo_host_org_repo_ci_uidx` keeps
 * the old case-sensitive index and raises a WARNING instead when case-only
 * duplicate repositories already exist, so that `prisma migrate deploy` never
 * fails on data it cannot fix. `migrate deploy` does not surface that warning,
 * so without this an operator would never learn the database guard is still
 * case-sensitive. The application's own pre-check is case-insensitive either
 * way; what the index adds is protection against two concurrent onboardings.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { hostFamily, platformCredentialScope } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { isGitHubDotComHost } from './repositoryHost.js';

export const REPO_IDENTITY_INDEX = 'connections_git_repo_host_org_repo_ci_uidx';

/** The statements that finish what the migration skipped, once duplicates are gone. */
export const REPO_IDENTITY_INDEX_SQL = `DROP INDEX IF EXISTS connections_git_repo_host_org_repo_uidx;
CREATE UNIQUE INDEX ${REPO_IDENTITY_INDEX} ON connections (COALESCE(github_url, ''), lower(organization_name), lower(repo_name)) WHERE type = 'git_repo';`;

const MAX_GROUPS_LOGGED = 50;

interface Logger {
  warn(obj: object, msg: string): void;
}

/**
 * Warns, naming the case-only duplicate groups, when the index is missing.
 * Returns whether it warned. Never throws: a failed check must not stop the
 * gateway starting.
 */
export async function warnIfRepoIdentityIndexMissing(
  prisma: PrismaClient,
  log: Logger
): Promise<boolean> {
  try {
    // CLAUDE.md §7 exception: Prisma cannot see database indexes, so the
    // catalog read is the one raw query here; the duplicate scan is Prisma.
    const present = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = ${REPO_IDENTITY_INDEX}
    `;
    if (present.length > 0) {
      return false;
    }

    const repos = await runUnscoped('a startup check spans every team', ['Connection'], () =>
      prisma.connection.findMany({
        select: { githubUrl: true, organizationName: true, repoName: true },
        where: { organizationName: { not: null }, repoName: { not: null }, type: 'git_repo' },
      })
    );
    const groups = new Map<string, number>();
    for (const r of repos) {
      const key = `${r.githubUrl ?? '<instance>'} ${r.organizationName?.toLowerCase()}/${r.repoName?.toLowerCase()}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const duplicates = [...groups].filter(([, n]) => n > 1).map(([key, n]) => `${key} (${n} rows)`);

    log.warn(
      {
        duplicateGroups: duplicates.length,
        duplicates: duplicates.slice(0, MAX_GROUPS_LOGGED),
        sql: REPO_IDENTITY_INDEX_SQL,
      },
      duplicates.length > 0
        ? `${REPO_IDENTITY_INDEX} does not exist: repositories that differ only by case are onboarded (see duplicates). The application still refuses new case-variant onboardings, but the database guard against two concurrent ones is case-sensitive until these are merged or deleted and the index is created with the SQL given.`
        : `${REPO_IDENTITY_INDEX} does not exist and no case-only duplicates were found; the database guard against concurrent case-variant onboardings is case-sensitive. Create the index with the SQL given.`
    );
    return true;
  } catch (err) {
    log.warn({ err }, 'could not check for the repository identity index');
    return false;
  }
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
