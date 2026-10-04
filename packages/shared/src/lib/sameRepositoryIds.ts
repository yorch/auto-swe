import type { PrismaClient } from '../index.js';
import { hostFamily } from './githubHostScope.js';
import { resolveGitHubConfig } from './systemConfig.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * `value` as a literal for a case-insensitive `equals`: Prisma compiles it to
 * `ILIKE` without escaping, so `\\`, `%` and `_` are escaped. The same rule as
 * the gateway's `insensitiveName`, which this package cannot import.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * The ids of every git repository connection that is the same repository as
 * `repoId`: the same host (a missing `githubUrl` override is the instance's own
 * host) and the same owner and name compared case-insensitively, as GitHub
 * does. Always includes `repoId` itself; a repository on another host with the
 * same owner and name is a different repository and is never included.
 *
 * The workflow id allocator uses it so that rows for one repository stored under
 * two casings (or with and without an override spelling out the instance host)
 * conflict with each other's in-flight runs rather than pushing the same branch
 * at once. The connection unique index already keeps same-identity rows out of
 * the database going forward; this covers the ones that predate it.
 */
export async function sameRepositoryIds(prisma: PrismaClient, repoId: string): Promise<string[]> {
  const own = await prisma.connection.findUnique({
    select: { githubUrl: true, organizationName: true, repoName: true },
    where: { id: repoId },
  });
  if (!(own?.organizationName && own.repoName)) {
    return [repoId];
  }
  const owner = own.organizationName.toLowerCase();
  const name = own.repoName.toLowerCase();
  const instanceBase = (await resolveGitHubConfig()).baseUrl;
  const ownHost = hostFamily(own.githubUrl ?? instanceBase);
  // Not tenant-filtered on purpose: the identity is global (one unique index
  // across every team), and a run of the same repository from another team
  // pushes the same branch just the same.
  const candidates = await runUnscoped('repository identity spans every team', ['Connection'], () =>
    prisma.connection.findMany({
      select: { githubUrl: true, id: true, organizationName: true, repoName: true },
      where: {
        // An archived row's stuck run must not block the live one; the
        // caller's own row counts whatever its state.
        OR: [{ isActive: true }, { id: repoId }],
        organizationName: { equals: likeLiteral(own.organizationName), mode: 'insensitive' },
        repoName: { equals: likeLiteral(own.repoName), mode: 'insensitive' },
        type: 'git_repo',
      },
    })
  );
  const ids = candidates
    .filter(
      (c) =>
        c.organizationName?.toLowerCase() === owner &&
        c.repoName?.toLowerCase() === name &&
        hostFamily(c.githubUrl ?? instanceBase) === ownHost
    )
    .map((c) => c.id);
  return ids.includes(repoId) ? ids : [repoId, ...ids];
}
