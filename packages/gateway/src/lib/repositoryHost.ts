/**
 * Matching an incoming GitHub payload to a repository by host as well as name.
 *
 * A repository's identity is (host, owner, name): `acme/api` on github.com and
 * on a GitHub Enterprise server are different repositories. A webhook names a
 * repository by `full_name`, which carries no host, so on its own it would
 * match both. The payload's `repository.html_url` does carry it.
 *
 * A connection's host is its web base override (`githubUrl`, stored as an
 * origin), or the instance's own host when that is null.
 */
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { originOf } from '@auto-swe/shared/lib/connectionCredential';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * The `Connection` predicate selecting repositories on the host `htmlUrl`
 * lives on.
 *
 * An absent or unparseable URL returns no constraint — the name-only match the
 * webhook made before repositories had a host. The instance's own host also
 * matches a row whose override spells that same host.
 */
export async function repositoryHostWhere(
  htmlUrl: string | undefined
): Promise<Prisma.ConnectionWhereInput> {
  const origin = htmlUrl ? originOf(htmlUrl) : null;
  if (!origin) {
    return {};
  }
  const instanceOrigin = originOf((await resolveGitHubConfig()).baseUrl);
  if (origin === instanceOrigin) {
    return { OR: [{ githubUrl: null }, { githubUrl: origin }] };
  }
  return { githubUrl: origin };
}

/**
 * The `Connection` predicate a webhook naming `org/repo` should match.
 *
 * The host is consulted only when the name alone is ambiguous — the same
 * owner/name onboarded on more than one host. A deployment reaching one host
 * matches by name exactly as it always did, so a configured web URL that spells
 * the host differently from what GitHub puts in `html_url` (an internal name, a
 * proxy) cannot make its webhooks stop matching.
 */
export async function webhookRepositoryWhere(
  prisma: PrismaClient,
  org: string,
  repoName: string,
  htmlUrl: string | undefined
): Promise<Prisma.ConnectionWhereInput> {
  const byName = { organizationName: org, repoName };
  if (!htmlUrl) {
    return byName;
  }
  const candidates = await runUnscoped(
    'a webhook names a GitHub repository, not a team',
    ['Connection'],
    () =>
      prisma.connection.findMany({
        select: { id: true },
        take: 2,
        where: { ...byName, type: 'git_repo' },
      })
  );
  if (candidates.length < 2) {
    return byName;
  }
  return { ...byName, ...(await repositoryHostWhere(htmlUrl)) };
}
