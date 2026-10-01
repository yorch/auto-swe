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
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
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

/**
 * Warns when two or more active repositories all override onto one and the
 * same foreign host. That shape usually means the instance's own GitHub host
 * (Studio -> GitHub integration web and API URLs) is wrong, not that every
 * repository is an exception: the platform credential is held to the instance's
 * host, so each of these repositories is refused it. Returns whether it
 * warned; never throws.
 */
export async function warnIfAllReposOnOneForeignHost(
  prisma: PrismaClient,
  log: Logger
): Promise<boolean> {
  try {
    const repos = await runUnscoped('a startup check spans every team', ['Connection'], () =>
      prisma.connection.findMany({
        select: { githubUrl: true },
        where: { isActive: true, type: 'git_repo' },
      })
    );
    if (repos.length < 2 || repos.some((r) => !r.githubUrl)) {
      return false;
    }
    const hosts = new Set(repos.map((r) => hostFamily(r.githubUrl as string)));
    if (hosts.size !== 1) {
      return false;
    }
    const ghConfig = await resolveGitHubConfig();
    const [host] = [...hosts];
    if (host === hostFamily(ghConfig.baseUrl)) {
      return false;
    }
    log.warn(
      { host, instanceHost: hostFamily(ghConfig.baseUrl), repositories: repos.length },
      `every active repository overrides onto ${host}, which is not the instance's GitHub host. The platform's credential is sent only to the instance's own host, so if its credential belongs to ${host}, set the GitHub integration's web and API URLs to ${host} (Studio -> Integrations -> GitHub).`
    );
    return true;
  } catch (err) {
    log.warn({ err }, 'could not check repository hosts against the instance host');
    return false;
  }
}
